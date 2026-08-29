/**
 * Runs index.html's renderers against fixture data in Node, covering the
 * acceptance list in BRIEF.md section 6: seeded data, every section failed
 * in turn, a backdated fetchedAt, and all three bin hero states.
 *
 *   node tools/render-test.mjs           summary
 *   node tools/render-test.mjs --verbose full tree for each case
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDocument, dump } from './dom.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dashboard.json'), 'utf8'));
const VERBOSE = process.argv.includes('--verbose');

const IDS = ['skyA', 'skyB', 'panel', 'content', 'houseName', 'place', 'stamp', 'foot', 'boot'];

/** Load the page's script with a stub environment and a given payload. */
async function render(payload, { httpFails = false } = {}) {
  const { registry, document } = makeDocument(IDS);
  const window = {
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 0,
    setInterval: () => 0,
  };
  const fetchStub = () => (httpFails
    ? Promise.reject(new Error('NetworkError'))
    : Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }));

  const run = new Function(
    'document', 'window', 'location', 'fetch', 'setTimeout', 'setInterval', 'Intl', 'console',
    script
  );
  run(document, window, { protocol: 'https:' }, fetchStub,
      window.setTimeout, window.setInterval, Intl, console);
  await new Promise((r) => setImmediate(r));
  return registry;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const ymd = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);
};

let fails = 0;
async function scenario(name, payload, expectations, opts) {
  const reg = await render(payload, opts);
  const text = reg.content.textContent;
  const tree = dump(reg.content);
  const bad = expectations.filter((e) => (e.absent ? text.includes(e.has) : !text.includes(e.has)));
  if (bad.length) {
    fails++;
    console.log(`\nFAIL  ${name}`);
    bad.forEach((e) => console.log(`        expected ${e.absent ? 'NOT to find' : 'to find'}: ${JSON.stringify(e.has)}`));
    console.log(tree.replace(/^/gm, '        '));
  } else {
    console.log(`ok    ${name}`);
    if (VERBOSE) console.log(tree.replace(/^/gm, '        '));
  }
  return reg;
}

/* -- bin hero, all three states -------------------------------------- */
function withBinDays(days) {
  const p = clone(seed);
  p.sections.bins.data.streams = [
    { key: 'garbage', name: 'General waste', lid: 'red', date: ymd(days),
      projected: false, weekday: 'Friday', frequency: 'Weekly', daysUntil: days },
    { key: 'recycling', name: 'Recycling', lid: 'yellow', date: ymd(days),
      projected: false, weekday: 'Friday', frequency: 'Fortnightly', daysUntil: days },
  ];
  return p;
}

console.log('Bin hero states');
await scenario('  due tonight', withBinDays(1), [
  { has: 'Bins out tonight' }, { has: 'General waste' }, { has: 'Recycling' },
]);
await scenario('  collection today', withBinDays(0), [
  { has: 'Collection today' },
]);
await scenario('  nothing due', withBinDays(6), [
  { has: 'General waste + Recycling out' }, { has: 'in 6 days' },
  { has: 'Bins out tonight', absent: true },
]);

/* -- every section failed with no prior value ------------------------ */
console.log('\nEach section failed with no prior value');
for (const key of ['bins', 'weather', 'air', 'holidays']) {
  const p = clone(seed);
  p.sections[key] = { ok: false, fetchedAt: new Date().toISOString(),
    error: `${key} upstream went away`, data: null };
  await scenario(`  ${key}`, p, [
    { has: `${key} upstream went away` },
    { has: 'No data has been collected yet' },
  ]);
}

/* -- stale: last good value carried forward, true age shown ---------- */
console.log('\nStale paths');
const stale = clone(seed);
for (const key of Object.keys(stale.sections)) {
  const s = stale.sections[key];
  stale.sections[key] = { ok: false, fetchedAt: new Date(Date.now() - 48 * 3600e3).toISOString(),
    error: 'connect ETIMEDOUT', data: s.data, stale: true };
}
await scenario('  fetchedAt backdated 48 h reads as 2 d', stale, [
  { has: '2 d' },
  { has: 'Showing the last good reading' },
  { has: 'connect ETIMEDOUT' },
]);

/* -- fire renders nothing when nothing is active --------------------- */
console.log('\nConditional fire card');
const quiet = clone(seed);
quiet.sections.fire = { ok: true, fetchedAt: new Date().toISOString(), data: null };
await scenario('  nothing active renders no card', quiet, [{ has: 'Fire', absent: true }]);

const active = clone(seed);
active.sections.fire = { ok: true, fetchedAt: new Date().toISOString(), data: {
  rating: { today: 'Extreme', tomorrow: 'High' }, ban: { today: true, tomorrow: false },
  incidents: [{ type: 'BUSHFIRE', suburb: 'STROMLO', km: 4.2 }],
  incidentCount: 1, radiusKm: 15 } };
await scenario('  active ban and incident render', active, [
  { has: 'Total fire ban today' }, { has: 'Extreme' }, { has: 'STROMLO' }, { has: '4.2 km' },
]);

const fireDown = clone(seed);
fireDown.sections.fire = { ok: false, fetchedAt: new Date().toISOString(),
  error: 'esa.act.gov.au: HTTP 503', data: null };
await scenario('  source down with no prior value still says so', fireDown, [
  { has: 'Fire' }, { has: 'esa.act.gov.au: HTTP 503' },
]);

/* -- the whole file fails -------------------------------------------- */
console.log('\nWhole-file failure');
await scenario('  dashboard.json unreachable', null, [
  { has: 'Could not load the dashboard file' }, { has: 'NetworkError' },
], { httpFails: true });

console.log(fails ? `\n${fails} scenario(s) failed\n` : '\nall scenarios passed\n');
process.exitCode = fails ? 1 : 0;
