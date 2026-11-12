/**
 * Browser app. This module only wires inputs to the engine and replays the
 * returned event log. All simulation semantics live in ../src/sim.js.
 */
import { simulate, buildReport, REASON } from '../src/sim.js';
import { SCENARIOS, findScenario, scenarioInput } from '../src/scenarios.js';
import { Replay } from '../src/replay.js';
import { StageView } from './stage.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  entry: SCENARIOS[0],
  strategy: SCENARIOS[0].scenario.cast.strategy,
  stripChanges: false,
  tick: 0,
  playing: false,
  speed: 1,
  showRejected: true,
  showLabels: true,
  report: null,
  replay: null,
  control: null,
  timer: null,
};

const stage = new StageView($('#stage'));

const REASON_LABEL = {
  chosen: '选中',
  origin: '起点自身',
  visited: '已访问',
  dead: '已死亡',
  departed: '已离场',
  faction: '阵营不符',
  source: '源对象不可选',
  notChosen: '未入选（落败）',
  budget: '预算耗尽',
};

const PHASE_LABEL = {
  worldChange: '世界变化',
  propagate: '传播时刻',
  hopLocked: '锁定下一跳',
  hit: '命中时刻',
  hopInterrupted: '命中校验失败',
  chainAborted: '链中止',
  budgetExhausted: '预算耗尽',
};

/**
 * Fit the canvas view to the scenario's actual unit bounds (plus margin).
 * An explicit `entry.view` still wins so scenarios keep a stable frame.
 */
function viewFor(entry, report) {
  if (entry.view) return entry.view;
  const units = report.initialUnits;
  const xs = units.map((u) => u.x);
  const ys = units.map((u) => u.y);
  const margin = 2;
  return {
    minX: Math.min(...xs) - margin,
    maxX: Math.max(...xs) + margin,
    minY: Math.min(...ys) - margin,
    maxY: Math.max(...ys) + margin,
  };
}

function compute() {
  const input = scenarioInput(state.entry, { stripChanges: state.stripChanges });
  input.cast = { ...input.cast, strategy: state.strategy };
  const sim = simulate(input);
  state.report = buildReport(sim);
  state.replay = new Replay(state.report);
  state.control = null;
  if (state.entry.compare) {
    const controlInput = scenarioInput(state.entry, { stripChanges: true });
    controlInput.cast = { ...controlInput.cast, strategy: state.strategy };
    const controlSim = simulate(controlInput);
    state.control = buildReport(controlSim);
  }
  const maxTick = Math.max(state.replay.lastTick, 1);
  $(`#scrubber`).max = String(maxTick);
  state.tick = Math.min(state.tick, maxTick);
  stage.setView(viewFor(state.entry, state.report));
}

function renderScenarios() {
  const list = $('#scenario-list');
  list.innerHTML = '';
  for (const entry of SCENARIOS) {
    const btn = document.createElement('button');
    btn.dataset.id = entry.id;
    btn.innerHTML = `<span>${entry.title}</span><span class="tag">${entry.scenario.cast.strategy}</span>`;
    btn.addEventListener('click', () => selectEntry(entry));
    list.appendChild(btn);
  }
  syncScenarioHeader();
}

function syncScenarioHeader() {
  document.querySelectorAll('#scenario-list button').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === state.entry.id));
  $('#scenario-desc').textContent = state.entry.description;
  $('#strategy-toggle').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.strategy === state.strategy));
}

function selectEntry(entry) {
  stopPlay();
  state.entry = entry;
  state.strategy = entry.scenario.cast.strategy;
  state.stripChanges = false;
  state.tick = 0;
  $('#compare-toggle').checked = false;
  compute();
  syncScenarioHeader();
  updateTieBreakNote();
  renderAll();
}

function renderStats() {
  const r = state.report;
  const frame = state.replay.frameAt(state.tick);
  const max = r.summary.maxHops;
  const locked = frame.locked.length;
  const applied = frame.resolved.filter((e) => e.status === 'applied').length;
  const interrupted = frame.resolved.filter((e) => e.status === 'interrupted').length;
  const damage = frame.resolved.reduce((s, e) => s + (e.damage ?? 0), 0);
  const abortedNow = r.aborted.filter((e) => e.tick <= state.tick).length;
  const budgetHit = r.budget.some((e) => e.tick <= state.tick);

  const stats = [
    ['已锁定跳数', `${locked}<small> / ${max}</small>`],
    ['预算消耗', `${locked}<small> / ${max}</small>`],
    ['已命中', `${applied}`],
    ['命中失效', `${interrupted}`],
    ['链中止', `${abortedNow}`],
    ['分支数', `${r.summary.branches}`],
    ['累计伤害', `${damage}`],
    ['预算耗尽', budgetHit ? '是' : '否'],
  ];
  const grid = $('#stats');
  grid.innerHTML = stats.map(([k, v]) =>
    `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  const elapsed = r.summary.path.slice(0, locked);
  grid.innerHTML += `<div class="stat wide"><div class="k">截至 t=${state.tick} 的传播路径（引擎实选）</div>` +
    `<div class="v path">${elapsed.join(' → ') || '（尚无）'}</div></div>`;
  grid.innerHTML += `<div class="stat wide"><div class="k">完整路径（终局）</div>` +
    `<div class="v path">${r.summary.path.join(' → ') || '（无）'}</div></div>`;
}

function renderDecision() {
  const frame = state.replay.frameAt(state.tick);
  const tbody = $('#candidate-table tbody');
  tbody.innerHTML = '';
  const decisions = frame.propagations;
  const table = $('#candidate-table');
  const empty = $('#decision-empty');

  if (decisions.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    empty.textContent = frame.tick === 0
      ? 't=0 仅施法；传播在 t=1 才开始。'
      : '当前时刻没有正在进行的传播决策。';
    $('#decision-context').textContent = '';
    return;
  }

  table.style.display = 'table';
  empty.style.display = 'none';
  $('#decision-context').textContent =
    decisions.map((d) => `t=${d.tick} @${d.originId} 预算 ${d.budgetBefore}→${d.budgetAfter}`)
      .join('  ·  ');

  const rows = [];
  for (const d of decisions) {
    for (const c of d.candidates) {
      const cls = c.state === 'chosen' ? 'chosen' : (c.reason ? 'reject' : '');
      const stateTag = c.state === 'chosen'
        ? '<span class="tag-pill tag-chosen">选中</span>'
        : c.state === REASON.NOT_CHOSEN
          ? '<span class="tag-pill tag-notChosen">未入选</span>'
          : c.state === REASON.BUDGET
            ? '<span class="tag-pill tag-budget">预算耗尽</span>'
            : `<span class="tag-pill tag-${c.state}">${REASON_LABEL[c.state] ?? c.state}</span>`;
      const distance = c.distance === null ? '—' : c.distance;
      rows.push(`<tr class="${cls}">
        <td>${c.id}</td>
        <td>${stateTag}</td>
        <td>${distance}</td>
        <td>${c.hp}</td>
        <td>${c.faction}</td>
        <td>${c.eligible ? (c.state === 'chosen' ? '选中' : '参与排序') : REASON_LABEL[c.reason] ?? c.reason}</td>
      </tr>`);
    }
  }
  tbody.innerHTML = rows.join('');
}

function renderLog() {
  const frame = state.replay.frameAt(state.tick);
  const log = frame.log;
  $('#log-count').textContent = `${log.length} 条`;
  const ol = $('#event-log');
  ol.innerHTML = log.map((line) =>
    `<li><span class="t">t=${line.tick}</span>` +
    `<span class="kind k-${line.kind}">${PHASE_LABEL_KIND(line.kind)}</span>` +
    `<span class="txt">${escapeHtml(line.text)}</span></li>`).join('');
  ol.scrollTop = ol.scrollHeight;
}

function PHASE_LABEL_KIND(kind) {
  return {
    cast: '施法', propagate: '传播', lock: '锁定', hit: '命中',
    interrupt: '失效', abort: '中止', budget: '预算', world: '世界',
  }[kind] ?? kind;
}

function renderCompare() {
  const box = $('#compare-result');
  if (!state.entry.compare || !state.control) {
    box.innerHTML = '<span class="same">仅“移动改变选择”场景提供对照。</span>';
    return;
  }
  const live = state.report.summary.path.join(' → ');
  const control = state.control.summary.path.join(' → ');
  const differs = live !== control;
  box.innerHTML =
    `<div class="row">启用变化：${live || '（无）'}</div>` +
    `<div class="row">对照运行：${control || '（无）'}</div>` +
    (differs
      ? '<span class="diff">✓ 相同的输入事件因对象状态变化而产生了不同的传播路径。</span>'
      : '<span class="same">两条路径一致：本场景的状态变化未影响选择。</span>');
}

function renderStage() {
  const frame = state.replay.frameAt(state.tick);
  const extra = { tick: state.tick };
  stage.draw(frame, state.report, extra);

  const phase = state.replay.propagationsAt(state.tick).length > 0
    ? '传播时刻：正在挑选下一跳'
    : state.replay.report.hits.some((h) => h.tick === state.tick)
      ? '命中时刻：结算已锁定的跳'
      : '等待';
  $('#phase-banner').textContent =
    `t=${state.tick} / ${state.replay.lastTick} · ${phase}`;
  $('#stage-status').textContent =
    `已锁定 ${frame.locked.length} · 待命中 ${frame.pending.length} · 已结算 ${frame.resolved.length}`;

  $('#tick-out').textContent = `t=${state.tick}`;
  $('#scrubber').value = String(state.tick);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAll() {
  renderStats();
  renderStage();
  renderDecision();
  renderLog();
  renderCompare();
  $('#tick-out').textContent = `t=${state.tick}`;
  $('#scrubber').value = String(state.tick);
  $('#btn-play').textContent = state.playing ? '暂停' : '播放';
}

// -- transport ---------------------------------------------------------------

function stopPlay() {
  state.playing = false;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  $('#btn-play').textContent = '播放';
}

function startPlay() {
  if (state.playing) return stopPlay();
  if (state.tick >= state.replay.lastTick) state.tick = 0;
  state.playing = true;
  $('#btn-play').textContent = '暂停';
  const interval = Math.max(80, 700 / state.speed);
  state.timer = setInterval(() => {
    if (state.tick >= state.replay.lastTick) {
      stopPlay();
      return;
    }
    state.tick += 1;
    renderAll();
  }, interval);
}

function bindTransport() {
  $('#btn-play').addEventListener('click', startPlay);
  $('#btn-step').addEventListener('click', () => {
    stopPlay();
    state.tick = Math.min(state.replay.lastTick, state.tick + 1);
    renderAll();
  });
  $('#btn-back').addEventListener('click', () => {
    stopPlay();
    state.tick = Math.max(0, state.tick - 1);
    renderAll();
  });
  $('#btn-reset').addEventListener('click', () => {
    stopPlay();
    state.tick = 0;
    renderAll();
  });
  $('#scrubber').addEventListener('input', (e) => {
    stopPlay();
    state.tick = Number(e.target.value);
    renderAll();
  });
  $('#speed').addEventListener('input', (e) => {
    state.speed = Number(e.target.value);
    $('#speed-out').textContent = `${state.speed.toFixed(1)}×`;
    if (state.playing) {
      clearInterval(state.timer);
      state.playing = false;
      startPlay();
    }
  });
}

function bindOptions() {
  $('#strategy-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.strategy = btn.dataset.strategy;
    $('#strategy-toggle').querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b === btn));
    stopPlay();
    state.tick = 0;
    compute();
    renderAll();
  });
  $('#compare-toggle').addEventListener('change', (e) => {
    state.stripChanges = e.target.checked;
    stopPlay();
    state.tick = 0;
    compute();
    renderAll();
  });
  $('#show-rejected').addEventListener('change', (e) => {
    state.showRejected = e.target.checked;
    stage.setOptions({ showRejected: state.showRejected });
    renderStage();
  });
  $('#show-labels').addEventListener('change', (e) => {
    state.showLabels = e.target.checked;
    stage.setOptions({ showLabels: state.showLabels });
    renderStage();
  });
}

function updateTieBreakNote() {
  const sim = state.report;
  const note = sim.tieBreak;
  $('#tiebreak-note').textContent = `${state.strategy === 'distance' ? '按距离' : '按最低生命值'} · 决胜：${note}`;
  const compareRow = $('#compare-row');
  const available = Boolean(state.entry.compare);
  $('#compare-toggle').disabled = !available;
  compareRow.classList.toggle('disabled', !available);
  if (!available) {
    $('#compare-toggle').checked = false;
    state.stripChanges = false;
  }
}

// -- init --------------------------------------------------------------------

function init() {
  renderScenarios();
  compute();
  updateTieBreakNote();
  bindTransport();
  bindOptions();
  renderAll();

  // expose a tiny hook for automated UI checks without a framework
  window.__lab = {
    get state() { return state; },
    setTick(t) { stopPlay(); state.tick = t; renderAll(); },
    stateAt(t = state.tick) {
      return [...state.replay.stateAtTick(t).values()]
        .map((u) => ({ id: u.id, hp: u.hp, alive: u.alive, onField: u.onField, x: u.x, y: u.y }));
    },
    frameAt(t = state.tick) {
      const f = state.replay.frameAt(t);
      return {
        tick: f.tick,
        locked: f.locked.length,
        pending: f.pending.length,
        resolved: f.resolved.length,
        rejections: f.rejections.length,
        propagations: f.propagations.length,
        logLength: f.log.length,
        budgetUsed: f.budgetUsed,
      };
    },
    reports() {
      return {
        path: state.report.summary.path,
        control: state.control?.summary.path ?? null,
        summary: state.report.summary,
        rejected: state.report.rejected,
        edges: state.report.edges,
        events: state.report.events,
      };
    },
    select(id) {
      selectEntry(findScenario(id));
      return state.entry.id;
    },
    setStrategy(s) {
      document.querySelector(`#strategy-toggle button[data-strategy="${s}"]`)?.click();
    },
  };
}

init();
