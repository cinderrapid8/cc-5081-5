import test from 'node:test';
import assert from 'node:assert/strict';

import { Replay } from '../src/replay.js';
import { runScenario } from '../src/sim.js';
import { findScenario, scenarioInput } from '../src/scenarios.js';

const report = (id) => runScenario(scenarioInput(findScenario(id)));

test('replay: world reconstruction reflects departures and damage', () => {
  const rp = new Replay(report('vanish'));
  const final = rp.stateAtTick(rp.lastTick);
  assert.equal(final.get('E2').onField, false);
  assert.equal(final.get('E4').onField, false);
  assert.equal(final.get('E5').onField, false);
  assert.equal(final.get('E1').hp, 40);
  assert.equal(final.get('E2').hp, 50, 'departed unit must not be damaged');
  assert.equal(final.get('E5').hp, 50, 'interrupted target must not be damaged');
});

test('replay: edges appear only after their lock and resolve at hit ticks', () => {
  const rp = new Replay(report('budget'));
  const e0 = rp.report.edges[0];
  assert.equal(rp.lockedAt(e0.lockedTick - 1).some((e) => e.hopId === e0.hopId), false);
  assert.equal(rp.lockedAt(e0.lockedTick).some((e) => e.hopId === e0.hopId), true);
  assert.equal(rp.pendingAt(e0.hitTick - 1).some((e) => e.hopId === e0.hopId), true);
  assert.equal(rp.resolvedAt(e0.hitTick - 1).some((e) => e.hopId === e0.hopId), false);
  assert.equal(rp.resolvedAt(e0.hitTick).some((e) => e.hopId === e0.hopId), true);
});

test('replay: rejections only surface on the tick they were decided', () => {
  const rp = new Replay(report('vanish'));
  assert.ok(rp.rejectionsAt(1).length > 0);
  assert.equal(rp.rejectionsAt(0).length, 0);
  const departed = rp.rejectionsAt(3).filter((r) => r.reason === 'departed');
  assert.ok(departed.length > 0, 'E2 departed before tick 3 propagation');
});

test('replay: log ordering is monotonic in event sequence', () => {
  const rp = new Replay(report('faction-switch'));
  const log = rp.logAt(rp.lastTick);
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].seq >= log[i - 1].seq, 'log must not reorder events');
  }
});

test('replay: budget counter matches locked edges over time', () => {
  const rp = new Replay(report('budget'));
  for (let t = 0; t <= rp.lastTick; t++) {
    const frame = rp.frameAt(t);
    assert.equal(frame.budgetUsed, rp.report.edges.filter((e) => e.lockedTick <= t).length);
    assert.ok(frame.budgetUsed <= frame.budgetMax);
  }
});

test('replay: no edge is fabricated — every locked edge traces to a propagate', () => {
  const rp = new Replay(report('fanout'));
  const propChosen = new Set();
  for (const p of rp.report.propagations) {
    for (const id of p.chosen) propChosen.add(`${p.tick}:${p.originId}:${id}`);
  }
  for (const edge of rp.report.edges) {
    assert.ok(propChosen.has(`${edge.lockedTick}:${edge.fromId}:${edge.toId}`),
      `edge ${edge.fromId}>${edge.toId} has no propagation decision backing it`);
  }
});
