/**
 * Shared scenario definitions. Used by the headless CLI demo, the tests and
 * the browser UI, so all three exercise the same engine and the same inputs.
 *
 * Coordinates are a plain abstract grid; the UI scales them to canvas space.
 * `changes` are scripted world mutations applied at the start of their tick,
 * before propagation and hits for that tick.
 */

export const SCENARIOS = [
  {
    id: 'eliminated',
    title: '锁定后死亡',
    description:
      'E3 在 t=5 被锁定（预计 t=8 命中），但 t=6 被击杀。命中阶段重新校验发现目标已死亡，' +
      '该跳记录为 targetDead 且伤害为 0；由 E3 触发的后续传播在 t=7 以 originDead 中止，' +
      '不会从尸体继续扩散。',
    view: { minX: -2, maxX: 7, minY: -3, maxY: 4 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'E1', faction: 'enemy', x: 1, y: 0, hp: 50 },
        { id: 'E2', faction: 'enemy', x: 2, y: 0, hp: 50 },
        { id: 'E3', faction: 'enemy', x: 3, y: 0, hp: 14 },
        { id: 'E4', faction: 'enemy', x: 4, y: 0, hp: 50 },
        { id: 'E5', faction: 'enemy', x: 5, y: 0, hp: 50 },
      ],
      cast: {
        id: 'fx-kill',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 5,
        fanout: 1,
        damage: 10,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [
        { tick: 6, type: 'kill', id: 'E3' },
      ],
    },
  },
  {
    id: 'same-distance',
    title: '同距目标',
    description:
      '目标 A 与 B 与起点的曼哈顿距离完全相同。距离策略必须以 id 升序决胜；' +
      '最低生命值策略则先比生命值。切换策略会改变首个目标。',
    view: { minX: -6, maxX: 6, minY: -5, maxY: 5 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'A', faction: 'enemy', x: 2, y: 1, hp: 40 },
        { id: 'B', faction: 'enemy', x: -1, y: -2, hp: 70 },
        { id: 'C', faction: 'enemy', x: 0, y: 4, hp: 30 },
        { id: 'N', faction: 'neutral', x: 1, y: -1, hp: 50 },
      ],
      cast: {
        id: 'fx-same',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 3,
        fanout: 1,
        damage: 12,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [],
    },
  },
  {
    id: 'ring',
    title: '环形排列',
    description:
      '八个目标在半径两格的环上等距排列。第一跳后每一步都只有相邻环点距离相等，' +
      '并列决胜规则让传播路径固定可复现。',
    view: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'E1', faction: 'enemy', x: 2, y: 0, hp: 50 },
        { id: 'E2', faction: 'enemy', x: 1, y: 1, hp: 50 },
        { id: 'E3', faction: 'enemy', x: 0, y: 2, hp: 50 },
        { id: 'E4', faction: 'enemy', x: -1, y: 1, hp: 50 },
        { id: 'E5', faction: 'enemy', x: -2, y: 0, hp: 50 },
        { id: 'E6', faction: 'enemy', x: -1, y: -1, hp: 50 },
        { id: 'E7', faction: 'enemy', x: 0, y: -2, hp: 50 },
        { id: 'E8', faction: 'enemy', x: 1, y: -1, hp: 50 },
        { id: 'N', faction: 'neutral', x: 0, y: 1, hp: 50 },
      ],
      cast: {
        id: 'fx-ring',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 8,
        fanout: 1,
        damage: 10,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [],
    },
  },
  {
    id: 'vanish',
    title: '连续消失',
    description:
      '目标在传播途中先离场，随后被跳过的目标再次离场。已被锁定但尚未命中的目标离场时，' +
      '命中阶段重新校验并记录 hopInterrupted，绝不按缓存位置扣血。',
    view: { minX: -2, maxX: 8, minY: -3, maxY: 4 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'E1', faction: 'enemy', x: 1, y: 0, hp: 50 },
        { id: 'E2', faction: 'enemy', x: 2, y: 0, hp: 50 },
        { id: 'E3', faction: 'enemy', x: 3, y: 0, hp: 50 },
        { id: 'E4', faction: 'enemy', x: 4, y: 0, hp: 50 },
        { id: 'E5', faction: 'enemy', x: 5, y: 0, hp: 50 },
        { id: 'E6', faction: 'enemy', x: 6, y: 0, hp: 50 },
      ],
      cast: {
        id: 'fx-vanish',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 6,
        fanout: 1,
        damage: 10,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [
        { tick: 3, type: 'depart', id: 'E2' },
        { tick: 5, type: 'depart', id: 'E4' },
        { tick: 6, type: 'depart', id: 'E5' },
        { tick: 9, type: 'depart', id: 'E6' },
      ],
    },
  },
  {
    id: 'budget',
    title: '预算耗尽',
    description:
      '六个目标排成一线，但总传播预算只有四跳。分支与主干共享同一预算，' +
      '预算归零时记录 budgetExhausted，不再选择下一跳。',
    view: { minX: -2, maxX: 8, minY: -3, maxY: 4 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'E1', faction: 'enemy', x: 1, y: 0, hp: 50 },
        { id: 'E2', faction: 'enemy', x: 2, y: 0, hp: 50 },
        { id: 'E3', faction: 'enemy', x: 3, y: 0, hp: 50 },
        { id: 'E4', faction: 'enemy', x: 4, y: 0, hp: 50 },
        { id: 'E5', faction: 'enemy', x: 5, y: 0, hp: 50 },
        { id: 'E6', faction: 'enemy', x: 6, y: 0, hp: 50 },
      ],
      cast: {
        id: 'fx-budget',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 4,
        fanout: 1,
        damage: 10,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [],
    },
  },
  {
    id: 'movement',
    title: '移动改变选择',
    description:
      '在传播进行时，目标 E3 向起点方向移动一格。原本 E2 与 E3 到 E1 的距离同为 3，' +
      'E2 凭 id 决胜胜出；移动后 E3 距离变为 2，直接胜出。同一输入仅切换“忽略脚本变化”' +
      '即可看到传播路径确实由对象状态改变驱动。',
    view: { minX: -2, maxX: 8, minY: -3, maxY: 5 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'E1', faction: 'enemy', x: 1, y: 0, hp: 50 },
        { id: 'E2', faction: 'enemy', x: 4, y: 0, hp: 50 },
        { id: 'E3', faction: 'enemy', x: 1, y: 3, hp: 50 },
        { id: 'E4', faction: 'enemy', x: 5, y: 0, hp: 50 },
      ],
      cast: {
        id: 'fx-move',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 4,
        fanout: 1,
        damage: 10,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [
        { tick: 2, type: 'move', id: 'E3', x: 1, y: 2 },      ],
    },
    compare: {
      label: '对照运行（移除移动脚本）',
      stripChanges: true,
    },
  },
  {
    id: 'faction-switch',
    title: '阵营改变',
    description:
      '分支目标在命中前改变阵营。锁定时的阵营检查会在命中时重新执行，' +
      '命中记录为 targetFactionChanged 且不扣血；其后续传播也作为 chainAborted 终止。',
    view: { minX: -2, maxX: 8, minY: -4, maxY: 4 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'E1', faction: 'enemy', x: 1, y: 0, hp: 50 },
        { id: 'E2', faction: 'enemy', x: 2, y: 0, hp: 50 },
        { id: 'E3', faction: 'enemy', x: 3, y: 0, hp: 50 },
        { id: 'E4', faction: 'enemy', x: 4, y: 0, hp: 50 },
        { id: 'A1', faction: 'ally', x: 2, y: 2, hp: 45 },
      ],
      cast: {
        id: 'fx-faction',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 4,
        fanout: 2,
        damage: 10,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [
        { tick: 3, type: 'setFaction', id: 'E2', faction: 'ally' },
      ],
    },
  },
  {
    id: 'fanout',
    title: '分叉共享预算',
    description:
      '每跳选择两个目标形成分叉，所有分支消耗同一份总预算。每条子链事件都带同一个 sourceEventId，' +
      '可回溯到唯一的施法事件。',
    view: { minX: -4, maxX: 4, minY: -4, maxY: 4 },
    scenario: {
      units: [
        { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
        { id: 'E1', faction: 'enemy', x: 1, y: 0, hp: 50 },
        { id: 'E2', faction: 'enemy', x: 0, y: 1, hp: 50 },
        { id: 'E3', faction: 'enemy', x: -1, y: 0, hp: 50 },
        { id: 'E4', faction: 'enemy', x: 0, y: -1, hp: 50 },
        { id: 'E5', faction: 'enemy', x: 2, y: 1, hp: 50 },
        { id: 'E6', faction: 'enemy', x: 1, y: 2, hp: 50 },
        { id: 'E7', faction: 'enemy', x: -1, y: 2, hp: 50 },
      ],
      cast: {
        id: 'fx-fanout',
        sourceUnitId: 'S',
        strategy: 'distance',
        maxHops: 6,
        fanout: 2,
        damage: 9,
        propDelayTicks: 2,
        hitDelayTicks: 3,
        filters: { factions: ['enemy'], allowSource: false },
      },
      changes: [],
    },
  },
];

export function findScenario(id) {
  const entry = SCENARIOS.find((s) => s.id === id);
  if (!entry) throw new Error(`unknown scenario: ${id}`);
  return entry;
}

/** Build the input for the engine, optionally dropping scripted changes. */
export function scenarioInput(entry, { stripChanges = false } = {}) {
  return {
    units: entry.scenario.units.map((u) => ({ ...u })),
    cast: { ...entry.scenario.cast, filters: { ...entry.scenario.cast.filters } },
    changes: stripChanges ? [] : entry.scenario.changes.map((c) => ({ ...c })),
  };
}
