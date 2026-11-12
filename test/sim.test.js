import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Simulation, simulate, buildReport, runScenario,
  compareId, manhattan, STRATEGIES, TIE_BREAK, REASON,
} from '../src/sim.js';
import { SCENARIOS, findScenario, scenarioInput } from '../src/scenarios.js';

const run = (id, opts) => runScenario(scenarioInput(findScenario(id), opts));
const hopsOf = (report) => report.edges.map((e) => `${e.fromId}>${e.toId}`);

function hpOf(report, id) {
  const final = report.units.find((u) => u.id === id);
  return final ? final.hp : undefined;
}

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

test('compareId is a natural, total order', () => {
  assert.ok(compareId('E2', 'E10') < 0, 'digit runs compare numerically');
  assert.ok(compareId('2', '10') < 0);
  assert.ok(compareId('A', 'a') < 0);
  assert.equal(compareId('x', 'x'), 0);
  const xs = ['E10', 'E2', 'B', '10', '2', 'A'];
  const sorted = xs.slice().sort(compareId);
  assert.deepEqual(sorted, ['2', '10', 'A', 'B', 'E2', 'E10']);
  // sorting is stable under repetition
  assert.deepEqual(sorted, xs.slice().sort(compareId));
});

test('manhattan distance is the metric used for targeting', () => {
  assert.equal(manhattan({ x: 0, y: 0 }, { x: 2, y: 1 }), 3);
  assert.equal(manhattan({ x: -1, y: -2 }, { x: 0, y: 0 }), 3);
});

test('declared strategies and tie-break text exist', () => {
  assert.deepEqual(STRATEGIES, ['distance', 'lowestHp']);
  assert.match(TIE_BREAK.distance, /id ascending/);
  assert.match(TIE_BREAK.lowestHp, /id ascending/);
});

// ---------------------------------------------------------------------------
// Same-distance targets + strategy switch
// ---------------------------------------------------------------------------

test('same-distance: distance strategy breaks the tie by id ascending', () => {
  const report = run('same-distance');
  // S(0,0) -> A(2,1)=3 and B(-1,-2)=3 tie; A wins by id.
  assert.equal(report.edges[0].toId, 'A');
  assert.deepEqual(report.propagations[0].chosen, ['A']);
  const a = report.propagations[0].candidates.find((c) => c.id === 'A');
  const b = report.propagations[0].candidates.find((c) => c.id === 'B');
  assert.equal(a.distance, b.distance, 'A and B must be truly equidistant');
  assert.equal(report.tieBreak, TIE_BREAK.distance);
});

test('same-distance: switching to lowestHp changes the first target', () => {
  const entry = findScenario('same-distance');
  const distanceRun = run('same-distance');
  const lowRun = runScenario({
    ...scenarioInput(entry),
    cast: { ...scenarioInput(entry).cast, strategy: 'lowestHp' },
  });
  assert.equal(distanceRun.edges[0].toId, 'A');
  // C has 30 hp, the lowest of the eligible enemies.
  assert.equal(lowRun.edges[0].toId, 'C');
  assert.notEqual(lowRun.edges[0].toId, distanceRun.edges[0].toId);
  assert.equal(lowRun.tieBreak, TIE_BREAK.lowestHp);
});

test('lowestHp: equal-hp candidates fall back to id ascending', () => {
  const ring = findScenario('ring');
  const input = scenarioInput(ring);
  const report = runScenario({
    ...input,
    cast: { ...input.cast, strategy: 'lowestHp' },
  });
  // Every enemy has 50 hp, so lowestHp must reproduce the same first hop as id order.
  assert.equal(report.edges[0].toId, 'E1');
});

// ---------------------------------------------------------------------------
// Ring arrangement
// ---------------------------------------------------------------------------

test('ring: equal-distance neighbours resolve in a stable cycle', () => {
  const report = run('ring');
  assert.deepEqual(hopsOf(report), [
    'S>E1', 'E1>E2', 'E2>E3', 'E3>E4',
    'E4>E5', 'E5>E6', 'E6>E7', 'E7>E8',
  ]);
  // Every hop in the ring traversal was equidistant to at least one sibling;
  // the fixed tie-break is what makes this path reproducible.
  const tiesBroken = report.propagations.filter((p) => {
    const survivors = p.candidates
      .filter((c) => c.state === 'chosen' || c.state === REASON.NOT_CHOSEN)
      .sort((a, b) => a.distance - b.distance);
    if (survivors.length < 2) return false;
    return survivors[0].distance === survivors[1].distance;
  });
  assert.ok(tiesBroken.length >= 5, 'ring must exercise tie-breaking repeatedly');
  assert.equal(report.summary.branches, 1);
});

test('ring: traversal never revisits and terminates cleanly', () => {
  const report = run('ring');
  const targets = report.edges.map((e) => e.toId);
  assert.equal(new Set(targets).size, targets.length, 'no target visited twice');
  assert.equal(report.summary.budgetExhausted, true);
  // The last edge is E7>E8; nothing propagates from E8 except a dead-end decision.
  const fromE8 = report.propagations.filter((p) => p.originId === 'E8');
  assert.equal(fromE8.length, 1, 'E8 is examined exactly once, at the end');
  assert.deepEqual(fromE8[0].chosen, []);
  assert.equal(fromE8[0].skipped, REASON.BUDGET);
});

test('ring: neutral unit is rejected for a hostile-only effect', () => {
  const report = run('ring');
  const first = report.propagations[0];
  const neutral = first.candidates.find((c) => c.id === 'N');
  assert.equal(neutral.eligible, false);
  assert.equal(neutral.reason, REASON.FACTION);
});

// ---------------------------------------------------------------------------
// Propagation vs hit timing
// ---------------------------------------------------------------------------

test('propagation and hit are separate events at separate ticks', () => {
  const report = run('same-distance');
  for (const edge of report.edges) {
    assert.ok(edge.hitTick > edge.lockedTick, 'hit must land after the lock');
    assert.equal(edge.resolvedTick, edge.hitTick);
  }
  assert.ok(report.propagations.every((e) => e.type === 'propagate'));
  assert.ok(report.hits.every((e) => e.type === 'hit'));
  // Locks and hits never share a tick in this scenario's timing.
  const lockTicks = new Set(report.locks.map((l) => l.lockedTick));
  const hitTicks = new Set(report.hits.map((h) => h.tick));
  assert.equal([...lockTicks].filter((t) => hitTicks.has(t)).length, 0);
});

test('hit damage is applied at the target position at hit time', () => {
  const report = run('movement');
  for (const hit of report.hits) {
    const live = report.units.find((u) => u.id === hit.toId);
    if (live) assert.deepEqual(hit.position, { x: live.x, y: live.y });
  }
});

// ---------------------------------------------------------------------------
// Continuous disappearance + stale locked hops
// ---------------------------------------------------------------------------

test('vanish: departed candidates are rejected at propagation time', () => {
  const report = run('vanish');
  const departedRejections = report.rejected.filter((r) => r.reason === REASON.DEPARTED);
  const departedIds = new Set(departedRejections.map((r) => r.candidateId));
  assert.ok(departedIds.has('E2'), 'E2 departs before it can be selected');
  assert.ok(departedIds.has('E4'), 'E4 departs before it can be selected');
});

test('vanish: a locked hop whose target leaves before the hit is interrupted, not cached', () => {
  const report = run('vanish');
  const interrupted = report.interrupted.find((e) => e.toId === 'E5');
  assert.ok(interrupted, 'E5 leaves between lock and hit');
  assert.equal(interrupted.reason, 'targetDeparted');
  assert.equal(interrupted.damage, 0);
  const edge = report.edges.find((e) => e.toId === 'E5');
  assert.equal(edge.status, 'interrupted');
  assert.equal(edge.damage, 0);
  // E5's hp must be untouched: no damage along a stale cached position.
  assert.equal(hpOf(report, 'E5'), 50);
});

test('vanish: a chain whose origin vanished aborts instead of propagating', () => {
  const report = run('vanish');
  const aborted = report.aborted.find((e) => e.originId === 'E5');
  assert.ok(aborted, 'E5 departs, so its scheduled propagation aborts');
  assert.match(aborted.reason, /Departed/);
  assert.ok(!report.edges.some((e) => e.fromId === 'E5' && e.status === 'applied'
    && report.propagations.some((p) => p.originId === 'E5' && p.chosen.length > 0)));
});

test('vanish: vanished units are never damaged and untouched units stay intact', () => {
  const report = run('vanish');
  const appliedTargets = new Set(report.hits.map((h) => h.toId));
  assert.ok(!appliedTargets.has('E2'));
  assert.ok(!appliedTargets.has('E4'));
  assert.ok(!appliedTargets.has('E5'));
  assert.equal(hpOf(report, 'E6'), 50, 'E6 is beyond the reached budget/chain');
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test('budget: total hops never exceed maxHops and exhaustion is logged', () => {
  const report = run('budget');
  assert.equal(report.edges.length, 4);
  assert.equal(report.summary.budgetUsed, 4);
  assert.equal(report.summary.budgetExhausted, true);
  assert.ok(report.budget.length >= 1);
  assert.equal(report.budget[0].used, 4);
  assert.deepEqual(hopsOf(report), ['S>E1', 'E1>E2', 'E2>E3', 'E3>E4']);
  assert.equal(hpOf(report, 'E5'), 50);
  assert.equal(hpOf(report, 'E6'), 50);
});

test('fanout: branches share one total budget and keep one source event', () => {
  const report = run('fanout');
  assert.equal(report.summary.fanout, 2);
  assert.ok(report.summary.branches > 1, 'fanout must create branches');
  assert.ok(report.edges.length <= report.summary.maxHops,
    'all branches together must stay inside maxHops');
  assert.equal(report.summary.hopsLocked, report.summary.budgetUsed);
  // Every effect event traces to the one cast event.
  const cast = report.cast;
  assert.ok(cast);
  for (const ev of report.effectEvents) {
    assert.equal(ev.sourceEventId, cast.sourceEventId, `event ${ev.type} lost its source`);
  }
  // All edges are resolved (no decorative pending edges).
  assert.ok(report.edges.every((e) => e.status === 'applied' || e.status === 'interrupted'));
});

// ---------------------------------------------------------------------------
// Killed after lock
// ---------------------------------------------------------------------------

test('eliminated: a locked target that dies before the hit is interrupted, not cached', () => {
  const report = run('eliminated');
  const edge = report.edges.find((e) => e.toId === 'E3');
  assert.ok(edge, 'E3 was locked at t=5');
  assert.equal(edge.lockedTick, 5);
  assert.equal(edge.hitTick, 8, 'the hit was scheduled for t=8');
  assert.equal(edge.status, 'interrupted');
  const ev = report.interrupted.find((e) => e.toId === 'E3');
  assert.equal(ev.reason, 'targetDead');
  assert.equal(ev.damage, 0);
  assert.equal(hpOf(report, 'E3'), 0, 'the kill, not the hop, set hp to 0');
  // damage would have been 4 (14 -> 10) had the target survived; it must be 0.
  assert.equal(ev.hpBefore ?? null, null, 'no hp data on an interrupted hop');
});

test('eliminated: propagation from a dead origin aborts, no corpse spread', () => {
  const report = run('eliminated');
  assert.ok(report.edges.every((e) => !(e.fromId === 'E3')));
  const aborted = report.aborted.find((e) => e.originId === 'E3');
  assert.ok(aborted);
  assert.equal(aborted.reason, 'originDead');
  // E4 and E5 were never reached: the chain stopped at the corpse.
  assert.equal(report.summary.path.join(' '), 'S>E1 E1>E2 E2>E3');
  assert.equal(hpOf(report, 'E4'), 50);
  assert.equal(hpOf(report, 'E5'), 50);
});

// ---------------------------------------------------------------------------
// Faction change
// ---------------------------------------------------------------------------

test('faction: locked target changing faction interrupts the hit', () => {
  const report = run('faction-switch');
  const interrupted = report.interrupted.find((e) => e.toId === 'E2');
  assert.ok(interrupted);
  assert.equal(interrupted.reason, 'targetFactionChanged');
  assert.equal(interrupted.damage, 0);
  assert.equal(hpOf(report, 'E2'), 50, 'E2 keeps its hp despite the locked hop');
});

test('faction: propagation from a re-factioned origin aborts', () => {
  const report = run('faction-switch');
  const aborted = report.aborted.find((e) => e.originId === 'E2');
  assert.ok(aborted);
  assert.match(aborted.reason, /FactionChanged/);
});

test('faction: the interrupted hop still consumes budget', () => {
  const report = run('faction-switch');
  // Locked: E1, E2, E3, E4 (fanout 2). E2's hit is interrupted; that does not refund.
  assert.equal(report.summary.hopsLocked, 4);
  assert.equal(report.summary.budgetUsed, 4);
  assert.equal(report.summary.hopsInterrupted, 1);
  assert.equal(report.summary.hopsApplied, 3);
});

// ---------------------------------------------------------------------------
// State changes really drive later selection
// ---------------------------------------------------------------------------

test('movement: moving a target changes the next selection versus the control run', () => {
  const moved = run('movement');
  const control = run('movement', { stripChanges: true });
  assert.deepEqual(moved.edges[0], moved.edges[0]);
  assert.equal(moved.edges[0].toId, 'E1');
  // Second hop differs precisely because E3 moved from (1,3) to (1,2).
  assert.equal(moved.edges[1].toId, 'E3');
  assert.equal(control.edges[1].toId, 'E2');
  assert.equal(moved.edges[1].toId !== control.edges[1].toId, true);
  // Confirm the distance that drove the choice.
  const prop = moved.propagations[1];
  const e2 = prop.candidates.find((c) => c.id === 'E2');
  const e3 = prop.candidates.find((c) => c.id === 'E3');
  assert.equal(e3.distance, 2);
  assert.equal(e2.distance, 3);
});

test('determinism: identical inputs reproduce identical paths and events', () => {
  for (const entry of SCENARIOS) {
    const a = run(entry.id);
    const b = run(entry.id);
    assert.deepEqual(a.summary.path, b.summary.path, `${entry.id} path must match`);
    assert.deepEqual(a.edges, b.edges, `${entry.id} edges must match`);
    assert.equal(JSON.stringify(a.events), JSON.stringify(b.events),
      `${entry.id} full event log must match`);
  }
});

// ---------------------------------------------------------------------------
// Rejections are real, drawn decisions
// ---------------------------------------------------------------------------

test('report: every rejected candidate carries a reason and an origin', () => {
  for (const id of ['same-distance', 'ring', 'vanish', 'faction-switch', 'fanout']) {
    const report = run(id);
    assert.ok(report.rejected.length > 0, `${id} must log rejected candidates`);
    for (const r of report.rejected) {
      assert.ok(r.reason && r.reason !== 'chosen');
      assert.ok(r.candidateId);
      assert.ok(r.originId);
      assert.ok(r.candidatePos);
    }
  }
});

test('report: chosen edges match locked hops exactly (no decoration)', () => {
  for (const entry of SCENARIOS) {
    const report = run(entry.id);
    const locked = report.locks.map((l) => `${l.fromId}>${l.toId}`);
    assert.deepEqual(report.edges.map((e) => `${e.fromId}>${e.toId}`), locked);
    assert.equal(report.summary.hopsLocked, report.locks.length);
    // Damage totals equal applied hits only.
    assert.equal(report.summary.totalDamage,
      report.hits.reduce((s, h) => s + h.damage, 0));
  }
});

test('runUntilIdle settles for every shared scenario', () => {
  for (const entry of SCENARIOS) {
    const sim = new Simulation(scenarioInput(entry));
    sim.runUntilIdle();
    assert.equal(sim.idle, true);
    assert.ok(sim.currentTick < 200);
  }
});

test('unknown strategy is rejected loudly', () => {
  const input = scenarioInput(findScenario('same-distance'));
  assert.throws(() => new Simulation({
    ...input,
    cast: { ...input.cast, strategy: 'nearest-ish' },
  }), /unknown strategy/);
});

test('world changes are recorded per tick', () => {
  const report = run('movement');
  const changes = report.events.filter((e) => e.type === 'worldChange');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].change, 'move');
  assert.equal(changes[0].unitId, 'E3');
  assert.equal(changes[0].tick, 2);
  assert.equal(changes[0].applied, true);
});
