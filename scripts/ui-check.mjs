#!/usr/bin/env node
/**
 * Real-browser UI verification (Playwright + headless Chromium).
 * Requires the dev server to be running on 4173 (or set BASE_URL).
 *
 *   node scripts/ui-check.mjs
 *
 * Verifies:
 *   - the page loads with no console errors
 *   - the canvas is actually drawn (non-blank pixels)
 *   - scrubbing changes world state (moves, departures, hp)
 *   - discarding scripted changes changes the propagation path
 *   - strategy toggle changes the first target for same-distance targets
 *   - rejected candidates and real executed edges are both present
 *
 * In this container Chromium needs a few system libs that ship with the base
 * image but are absent, so run it with:
 *   LD_LIBRARY_PATH=... FONTCONFIG_FILE=... node scripts/ui-check.mjs
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/ui/';
const OUT = process.env.SHOT_DIR ?? '/tmp/lab-shots';
const fs = await import('node:fs/promises');
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

const fail = [];
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); fail.push(name); }
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__lab && window.__lab.state.report);
await page.waitForTimeout(250);

const canvasPainted = async () => page.evaluate(() => {
  const c = document.querySelector('#stage');
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let nonTransparent = 0;
  let colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) nonTransparent++;
    // any pixel that is not near-black grid
    if (data[i] + data[i + 1] + data[i + 2] > 120) colored++;
  }
  return { nonTransparent, colored, w: c.width, h: c.height };
});

// -- 1. load + paint ---------------------------------------------------------
const paint = await canvasPainted();
check('canvas has painted pixels', paint.colored > 2000, JSON.stringify(paint));
check('no console errors on load', consoleErrors.length === 0, consoleErrors.join(' | '));

// -- 2. frame zero: no edges, rejections visible after t=1 -------------------
await page.evaluate(() => window.__lab.setTick(0));
await page.screenshot({ path: `${OUT}/01-start.png` });
let data = await page.evaluate(() => window.__lab.reports());
check('initial path is the engine path', data.path.length > 0, JSON.stringify(data.path));
const f0 = await page.evaluate(() => window.__lab.frameAt(0));
check('t=0 has no locked edges (no pre-drawn curve)', f0.locked === 0, JSON.stringify(f0));
const f1 = await page.evaluate(() => window.__lab.frameAt(1));
check('t=1 locks the first edge', f1.locked === 1, JSON.stringify(f1));
check('t=1 shows the pending target and no resolved edge yet',
  f1.pending === 1 && f1.resolved === 0, JSON.stringify(f1));

// -- 3. same-distance: tie-break and strategy switch -------------------------
await page.evaluate(() => window.__lab.select('same-distance'));
await page.waitForTimeout(120);
await page.evaluate(() => window.__lab.setTick(1));
await page.screenshot({ path: `${OUT}/02-same-distance-tick1.png` });
data = await page.evaluate(() => window.__lab.reports());
check('distance strategy first hop = A (id tie-break)', data.path[0] === 'S>A', data.path.join(' '));
const rejected1 = data.rejected.filter((r) => r.tick === 1);
check('rejections recorded at first propagation', rejected1.length >= 3, JSON.stringify(rejected1.map(r => r.reason)));

await page.evaluate(() => window.__lab.setStrategy('lowestHp'));
await page.waitForTimeout(120);
data = await page.evaluate(() => window.__lab.reports());
check('lowestHp strategy picks the lowest-hp enemy (C)', data.path[0] === 'S>C', data.path.join(' '));
await page.evaluate(() => window.__lab.setStrategy('distance'));
await page.waitForTimeout(120);

// -- 4. scrub through a scenario and confirm live state changes --------------
await page.evaluate(() => window.__lab.select('vanish'));
await page.waitForTimeout(120);
const frames = [];
for (const t of [0, 3, 5, 8]) {
  await page.evaluate((tt) => window.__lab.setTick(tt), t);
  frames.push(await page.evaluate((tt) => ({
    tick: tt,
    units: window.__lab.stateAt(tt),
    frame: window.__lab.frameAt(tt),
  }), t));
}
const at3 = frames.find((f) => f.tick === 3);
const at8 = frames.find((f) => f.tick === 8);
check('E2 departs by t=3 visible in canvas state',
  at3.units.find((u) => u.id === 'E2').onField === false);
check('E5 untouched at t=8 despite a locked hop (interrupted)',
  at8.units.find((u) => u.id === 'E5').hp === 50);
check('E1 took damage by t=8', at8.units.find((u) => u.id === 'E1').hp < 50);
await page.evaluate(() => window.__lab.setTick(8));
await page.screenshot({ path: `${OUT}/03-vanish-tick8.png` });

// -- 5. movement vs control: state change drives selection -------------------
await page.evaluate(() => window.__lab.select('movement'));
await page.waitForTimeout(120);
data = await page.evaluate(() => window.__lab.reports());
check('movement run picks E3 second', data.path[1] === 'E1>E3', data.path.join(' '));
check('control exists', Array.isArray(data.control), JSON.stringify(data.control));
check('control path differs from live path',
  data.control.join('>') !== data.path.join('>'),
  `${data.path.join(' ')} vs ${data.control.join(' ')}`);
await page.evaluate(() => window.__lab.setTick(3));
await page.screenshot({ path: `${OUT}/04-movement-tick3.png` });

// -- 6. budget exhaustion ----------------------------------------------------
await page.evaluate(() => window.__lab.select('budget'));
await page.waitForTimeout(120);
data = await page.evaluate(() => window.__lab.reports());
check('budget caps hops at 4', data.path.length === 4, data.path.join(' '));
check('budget exhausted flagged', data.summary.budgetExhausted === true);
await page.evaluate(() => window.__lab.setTick(7));
await page.screenshot({ path: `${OUT}/05-budget-tick7.png` });

// -- 7. fanout branches keep one source event --------------------------------
await page.evaluate(() => window.__lab.select('fanout'));
await page.waitForTimeout(120);
data = await page.evaluate(() => window.__lab.reports());
check('fanout produced branches', data.summary.branches > 1, String(data.summary.branches));
const sourceIds = new Set(data.events.filter((e) => e.type !== 'worldChange')
  .map((e) => e.sourceEventId));
check('all effect events share a single source event id',
  sourceIds.size === 1 && [...sourceIds][0] === 'fx-fanout', JSON.stringify([...sourceIds]));
await page.evaluate(() => window.__lab.setTick(5));
await page.screenshot({ path: `${OUT}/06-fanout-tick5.png` });

// -- 8. executed edges match locks, rejections are drawn --------------------
check('executed edges equal locked hops',
  data.edges.length === data.summary.hopsLocked,
  `${data.edges.length} vs ${data.summary.hopsLocked}`);
const rejectedTotal = data.rejected.length;
check('rejected candidates are recorded for drawing', rejectedTotal > 0, String(rejectedTotal));

// -- 9. play button advances time ------------------------------------------
await page.evaluate(() => window.__lab.select('same-distance'));
await page.waitForTimeout(120);
await page.evaluate(() => window.__lab.setTick(0));
await page.click('#btn-play');
await page.waitForTimeout(900);
const advanced = await page.evaluate(() => window.__lab.state.tick);
check('play advances the clock', advanced > 0, String(advanced));
await page.click('#btn-play');
await page.evaluate(() => window.__lab.setTick(8));
await page.screenshot({ path: `${OUT}/07-final-frame.png` });

await browser.close();
await writeFile(`${OUT}/report.json`, JSON.stringify({ fail, consoleErrors }, null, 2));

if (consoleErrors.length) {
  console.log('CONSOLE ERRORS:', consoleErrors.join('\n'));
}
if (fail.length) {
  console.log(`\n${fail.length} UI CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nAll UI checks passed.');
