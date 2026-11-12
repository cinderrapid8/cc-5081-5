#!/usr/bin/env node
/**
 * Headless demo. Prints the full propagation/hit timeline for a shared
 * scenario, proving the engine runs with no browser and no canvas.
 *
 *   node scripts/demo.mjs                 # all scenarios
 *   node scripts/demo.mjs ring            # one scenario
 *   node scripts/demo.mjs movement --control
 */

import { SCENARIOS, findScenario, scenarioInput } from '../src/scenarios.js';
import { simulate, buildReport, REASON } from '../src/sim.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));

let strategy = null;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--strategy=')) strategy = args[i].split('=')[1];
  else if (args[i] === '--strategy' && args[i + 1]) strategy = args[i + 1];
}

// scenario ids are positional args that are neither flags nor flag values
const skip = new Set();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strategy') { skip.add(i); skip.add(i + 1); }
  if (args[i].startsWith('--strategy=')) skip.add(i);
}
const ids = args.filter((a, i) => !a.startsWith('--') && !skip.has(i));

if (strategy && !['distance', 'lowestHp'].includes(strategy)) {
  console.error(`unknown strategy: ${strategy}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const sep = () => console.log('─'.repeat(96));

function winnerText(report) {
  const s = report.summary;
  return `${s.hopsLocked} hops locked, ${s.hopsApplied} applied, ` +
    `${s.hopsInterrupted} interrupted, ${s.aborted} chain aborts, ` +
    `budget ${s.budgetUsed}/${s.maxHops}${s.budgetExhausted ? ' (exhausted)' : ''}`;
}

function printTimeline(report) {
  sep();
  console.log(`${report.cast?.effectId}  strategy=${report.strategy}  ` +
    `tieBreak="${report.tieBreak}"`);
  console.log(`sourceEventId=${report.summary.sourceEventId}  ` +
    `origin=${report.cast?.originId}  fanout=${report.summary.fanout}  ` +
    `damage=${report.summary.damage}`);
  sep();
  for (const ev of report.effectEvents) {
    const tt = `t=${String(ev.tick).padStart(2)}`;
    switch (ev.type) {
      case 'cast':
        console.log(`${tt} CAST      ${ev.originId}`);
        break;
      case 'propagate': {
        const chosen = ev.chosen.length ? ev.chosen.join(',') : '(none)';
        const states = ev.candidates
          .filter((c) => c.state !== 'chosen')
          .map((c) => `${c.id}:${c.state}${c.distance !== null ? `@${c.distance}` : ''}`)
          .join(' ');
        console.log(`${tt} PROPAGATE ${pad(ev.originId, 4)} ` +
          `budget ${ev.budgetBefore}->${ev.budgetAfter}  chosen=[${chosen}]  ` +
          `others: ${states}`);
        break;
      }
      case 'hopLocked':
        console.log(`${tt}   LOCK    ${pad(ev.fromId, 4)} -> ${pad(ev.toId, 4)} ` +
          `hit@t=${ev.hitTick} (propagation time)`);
        break;
      case 'hit':
        console.log(`${tt}   HIT     ${pad(ev.fromId, 4)} -> ${pad(ev.toId, 4)} ` +
          `-${ev.damage} hp ${ev.hpBefore}->${ev.hpAfter}${ev.killed ? ' KILL' : ''}`);
        break;
      case 'hopInterrupted':
        console.log(`${tt}   INTERRUPTED ${pad(ev.fromId, 4)} -> ${pad(ev.toId, 4)} ` +
          `reason=${ev.reason} damage=0 (no cached-position damage)`);
        break;
      case 'chainAborted':
        console.log(`${tt}   ABORT   chain ${ev.chainId} at ${ev.originId} reason=${ev.reason}`);
        break;
      case 'budgetExhausted':
        console.log(`${tt}   BUDGET  used=${ev.used}/${ev.maxHops} -> stop selecting`);
        break;
      case 'worldChange':
        console.log(`${tt}   WORLD   ${ev.change} ${ev.unitId}` +
          (ev.detail?.x !== undefined ? ` -> (${ev.detail.x},${ev.detail.y})` : '') +
          (ev.detail?.faction ? ` -> ${ev.detail.faction}` : ''));
        break;
      default:
        break;
    }
  }
  sep();
  console.log('Path:', report.summary.path.join('  '));
  console.log('Rejected:', report.rejected.length === 0 ? '(none)' : '');
  for (const r of report.rejected) {
    console.log(`  t=${r.tick} from ${r.originId} candidate ${r.candidateId} ` +
      `(${r.candidatePos.x},${r.candidatePos.y}) -> ${r.reason}`);
  }
  console.log('Final hp:', report.units.map((u) => `${u.id}=${u.hp}`).join(' '));
  console.log(winnerText(report));
}

function printCompare(a, b) {
  sep();
  console.log('COMPARE: scripted state change vs. control');
  console.log(`with changes : ${a.summary.path.join('  ')}`);
  console.log(`control      : ${b.summary.path.join('  ')}`);
  const differs = a.summary.path.join('>') !== b.summary.path.join('>');
  console.log(differs
    ? '=> the state change genuinely altered the selected propagation path'
    : '=> identical path (no decision influenced by the change)');
}

const selected = ids.length ? ids.map((id) => findScenario(id)) : SCENARIOS;
if (ids.length && selected.length === 0) {
  console.error(`unknown scenario(s): ${ids.join(', ')}`);
  process.exit(1);
}

for (const entry of selected) {
  console.log(`\n### ${entry.title} (${entry.id})`);
  console.log(entry.description);
  const input = scenarioInput(entry);
  if (strategy) input.cast = { ...input.cast, strategy };
  const sim = simulate(input);
  const report = buildReport(sim);
  printTimeline(report);
  if (flags.has('--control') || entry.compare) {
    const controlInput = scenarioInput(entry, { stripChanges: true });
    if (strategy) controlInput.cast = { ...controlInput.cast, strategy };
    const control = buildReport(simulate(controlInput));
    printCompare(report, control);
  }
}
