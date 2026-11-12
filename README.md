# 连锁传播实验台 · Chain Reaction Lab

确定性、可复现的多跳连锁传播实验台。核心结算引擎不依赖 DOM、不依赖画面，可以单独运行、单独测试；界面只负责回放引擎产出的**真实事件日志**。

```bash
npm test                                  # 34 个引擎/回放测试
npm run demo                              # 全部场景，纯终端输出
npm run demo -- vanish movement           # 指定场景（movement 自动附对照运行）
npm run demo -- same-distance --strategy=lowestHp
npm run serve                             # 打开 http://127.0.0.1:4173/ui/
```

## 为什么这不是“提前画好的一条曲线”

- 所有连线来自 `hopLocked` 事件，只有传播阶段真的选中了目标才会存在。
- 每个 `hopLocked` 在若干 tick 后由一次独立的 `hit` 或 `hopInterrupted` 事件结算。
- 回放层（`src/replay.js`）按 tick 重建世界：`t` 时刻可见的边必须满足 `lockedTick <= t`，结算状态必须满足 `resolvedTick <= t`。
- 测试 `report: chosen edges match locked hops exactly` 与 `replay: no edge is fabricated` 直接锁死这一点：界面无法凭空多画一条边。

## 时间模型

时间以整数 tick 推进。每个 tick 依次执行三件事：

1. **世界变化** — 脚本化的移动 / 死亡 / 离场 / 阵营切换 / 移除。
2. **传播时刻** — 每个到期的传播动作过滤并排序候选，锁定下一跳。
3. **命中时刻** — 每个到期的跳重新校验两端，然后结算伤害。

传播与命中是**两个不同时刻、两类不同事件**，各有自己的 tick：

```
t=1  propagate  S budget 6->5 chosen [E1]
t=1  hopLocked  S -> E1        hitTick = 4
t=4  hit        S -> E1        -10 hp 50->40
```

锁定时记录的是“意向”，命中时才产生伤害。这个间隔是刻意留出的，好让目标状态在中间发生变化。

## 失效状态如何处理（不沿缓存位置继续扣血）

每次命中都会对**锁定后的对象**重新校验，而不是沿用锁定那一刻的快照：

| 检查项 | 失败时记录 |
| --- | --- |
| 目标已移除 | `targetRemoved` |
| 目标已离场 | `targetDeparted` |
| 目标已死亡 | `targetDead` |
| 目标阵营已不符 | `targetFactionChanged` |
| 起点已移除 / 离场 / 死亡 | `originRemoved` / `originDeparted` / `originDead` |
| 起点（非施法者）阵营改变 | `originFactionChanged` |

失败时写入 `hopInterrupted`，`damage = 0`，目标生命值保持不变。事件同时记录：

- `fromPos` / `lockedToPos`：锁定时的位置（仅作为“当时的意向”展示）
- `targetPos`：命中时的实时位置（可能为 `null`，表示已移除）

界面在该边目标已经移动时，会画一个空心圈标出**锁定位置**，并用虚线连到**当前实际位置**——缓存位置只以“缓存”的身份出现，不会被当成伤害落点。

传播动作本身在执行时也会重校验起点。若起点在这段时间内死亡 / 离场 / 改变阵营，该动作记录 `chainAborted` 并停止选择，不会从一个已经不成立的节点继续扩散。

**已排期的动作不会因为后续命中失败而被追溯撤销。** 每个动作只在自己的执行时刻校验；因此一次失败命中不会“反悔”已经发生的选择，但会让从这个失效节点出发的未来传播以 `chainAborted` 终止。这一条在测试 `vanish` / `eliminated` / `faction-switch` 里都有断言。

## 目标选择

过滤顺序固定，候选表里每一行都写明它被哪一步筛掉：

```
起点自身 → 已访问 → 已死亡 → 已离场 → 阵营不符 → 源对象不可选
```

两种策略只在此基础上排序：

| 策略 | 主键 | 并列决胜 |
| --- | --- | --- |
| `distance` | 曼哈顿距离升序 | 自然 id 升序（`E2` < `E10`） |
| `lowestHp` | 有效生命值升序 | 自然 id 升序 |

决胜规则是**固定的、写进事件的**（`tieBreak` 字段），不使用任何随机数。因此相同输入必然复现相同传播路径——`determinism` 测试会逐场景比对完整事件日志的 JSON。

`visited` 按效果全局维护，在锁定时刻加入；一个目标即使后续命中失效，也保持“已访问”，不会在同一次效果里被重复遍历。

### 分叉与预算

- 每次传播可选 `fanout` 个目标，形成分叉。
- 所有分支共享**同一份总预算** `maxHops`，以“锁定”计费；被中断的跳**照样计入消耗**（选择已经发生）。
- 预算归零时并非静默停止：仍会产生一条终局的传播决策，把当时的真实候选全部标为“预算不足”，并记录 `budgetExhausted`。
- 每个效果的所有子链事件都带同一个 `sourceEventId`（施法事件的 id），可以回溯到唯一的源事件。

## 界面

三栏布局：左侧场景 / 策略 / 时间轴，中间画布与决策表，右侧事件日志与对照结果。

画布只画真实数据：

- **实线带箭头**：已命中的边
- **虚线**：已锁定但尚未命中的边（标注预计命中 tick）
- **红色虚线 + ✕**：命中时校验失败
- **灰色虚线 + 菱形**：被拒绝的候选（带原因，同刻同因会合并计数）
- **空心圈 + 点线**：目标已移动时，锁定位置与当前位置的偏离

下面的决策表逐行列出当时的每个候选、状态、距离、HP、阵营与裁决；右侧日志逐条列出施法 / 传播 / 锁定 / 命中 / 失效 / 中止 / 预算 / 世界变化。

“移动改变选择”场景额外提供**对照运行**：同一场景去掉脚本化移动后再跑一遍，两次路径并排显示，证明选择确实由状态变化驱动，而不是预置的固定路线。

## 场景

| id | 内容 |
| --- | --- |
| `eliminated` | 目标被锁定后在命中前死亡：`targetDead` + 后续 `originDead` 中止 |
| `same-distance` | 同距目标，两种策略给出不同首跳 |
| `ring` | 环形等距排列，连续并列决胜 |
| `vanish` | 目标连续离场，含锁定后离场的中断 |
| `budget` | 六目标一线、预算只有四跳 |
| `movement` | 移动改变下一跳，并提供对照运行 |
| `faction-switch` | 命中前阵营改变：`targetFactionChanged` + 传播中止 |
| `fanout` | 分叉共享预算，子链共同源事件 |

## 结构

```
src/sim.js        引擎（纯逻辑，无 DOM）
src/scenarios.js  共享场景定义（引擎/测试/界面同源）
src/replay.js     事件日志 → 逐 tick 回放状态
ui/stage.js       Canvas 绘制（只消费回放数据）
ui/app.js         界面装配与交互
scripts/demo.mjs  无界面演示
scripts/serve.mjs 零依赖开发服务器
scripts/ui-check.mjs 真实浏览器校验（Playwright）
test/             node:test 测试
```

### 浏览器校验

`scripts/ui-check.mjs` 用真实 Chromium 验证页面无报错、画布确有像素输出、拖动时间轴会改变世界状态、切换策略会改变首跳、以及“已执行边 = 已锁定跳”。在缺少图形库的环境里可显式指定库路径：

```bash
LD_LIBRARY_PATH=/tmp/chrome-libs/usr/lib/aarch64-linux-gnu:/tmp/chrome-libs/lib/aarch64-linux-gnu \
FONTCONFIG_FILE=/tmp/fonts.conf \
node scripts/ui-check.mjs
```
