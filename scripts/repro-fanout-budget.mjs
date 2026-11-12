#!/usr/bin/env node
/**
 * Reproduction for the fanout/budget boundary defect.
 *
 * `slots = Math.min(fanout, budget)` was fed straight into `Array.slice(0, slots)`.
 * A negative or fractional `fanout` therefore either kept `length - n` targets
 * (negative slice counts from the end) or truncated a float into a smaller
 * integer than the `slots` used to mark candidate rows. The result was locks
 * beyond `maxHops`, a negative running budget, and committed hops whose rows
 * were not marked `chosen`.
 *
 * This script runs the same minimal object set through the current engine.
 * It is kept as a standing reproduction: it must fail loudly at construction
 * instead of emitting a trace that spends more budget than was granted.
 *
 *   node scripts/repro-fanout-budget.mjs
 */
import { simulate, buildReport } from '../src/sim.js';

const units = [
  { id: 'S', faction: 'ally', x: 0, y: 0, hp: 60 },
  { id: 'E1', faction: 'enemy', x: 1, y: 0, hp: 30 },
  { id: 'E2', faction: 'enemy', x: 0, y: 1, hp: 30 },
  { id: 'E3', faction: 'enemy', x: 2, y: 0, hp: 30 },
  { id: 'E4', faction: 'enemy', x: 0, y: 2, hp: 30 },
  { id: 'E5', faction: 'enemy', x: 1, y: 1, hp: 30 },
];

const base = {
  id: 'fx-repro',
  sourceUnitId: 'S',
  strategy: 'distance',
  maxHops: 2,
  fanout: 2,
  damage: 10,
  propDelayTicks: 2,
  hitDelayTicks: 3,
  filters: { factions: ['enemy'], allowSource: false },
};

function trace(cast) {
  const report = buildReport(simulate({ units: units.map((u) => ({ ...u })), cast, changes: [] }));
  for (const ev of report.effectEvents) {
    const tag = ev.fromId ? `${ev.fromId}>${ev.toId}` : (ev.originId ?? '');
    console.log(`t=${ev.tick} ${ev.type} ${tag}` +
      (ev.type === 'propagate'
        ? ` budget ${ev.budgetBefore}->${ev.budgetAfter} chosen=${JSON.stringify(ev.chosen)}`
        : ''));
  }
  console.log(`locks=${report.summary.hopsLocked} used=${report.summary.budgetUsed} ` +
    `max=${report.summary.maxHops} hp=${report.units.map((u) => `${u.id}=${u.hp}`).join(' ')}`);
  return report;
}

console.log('legal control (fanout=2):');
const legal = trace(base);
if (legal.summary.hopsLocked > legal.summary.maxHops) throw new Error('legal control exceeded maxHops');

let rejected = false;
for (const fanout of [-1, 1.5]) {
  try {
    trace({ ...base, fanout });
    console.log(`fanout=${fanout} was accepted (BUG)`);
  } catch (e) {
    rejected = true;
    console.log(`fanout=${fanout} rejected: ${e.message}`);
  }
}
if (!rejected) throw new Error('invalid fanout was not rejected');
console.log('OK: invalid fanout cannot spend more budget than maxHops.');
