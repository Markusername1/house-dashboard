/**
 * Development checks for the acceptance list in BRIEF.md section 6.
 * Not part of the site and not a build step — the page ships as it is.
 *
 *   node tools/check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let fails = 0;
const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m) => { fails++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? pass(m) : fail(m));

/* ---- 1. the inline script parses ---------------------------------- */
console.log('\nSyntax');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
try {
  new Function(script);
  pass('inline script parses');
} catch (e) {
  fail(`inline script: ${e.message}`);
}

/* ---- 2. contrast floor at every minute of the year ----------------- */
/* The sky block is pure and self-contained, so it can be lifted straight
   out of the page and exercised directly. */
const sky = script.slice(
  script.indexOf('/* ==SKY-START=='),
  script.indexOf('/* ==SKY-END== */')
);
const M = new Function(sky + `
  return { skyAt, luminance, over, hexToRgb, PANEL_BASE, PANEL_MAX_L };
`)();

const INK   = [237, 241, 246];
const ALPHA = { '--ink': 1, '--ink-2': 0.80, '--ink-3': 0.66 };
const VEIL_OFF = true;   /* the veil only darkens further; ignoring it is conservative */

function contrast(a, b) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

console.log('\nContrast on the panel, every minute of every sunrise/sunset pair');
let worst = { ratio: Infinity };
/* Canberra's real extremes, plus the equinox. */
for (const [sr, ss, label] of [[390, 1065, 'equinox'], [355, 1230, 'midsummer'], [440, 1010, 'midwinter']]) {
  for (let m = 0; m <= 1440; m += 1) {
    const s = M.skyAt(m, sr, ss);
    for (const stop of s.stops) {
      const panel = M.over(M.PANEL_BASE, stop, s.alpha);
      for (const [name, a] of Object.entries(ALPHA)) {
        const text = M.over(INK, panel, a);
        const ratio = contrast(M.luminance(text), M.luminance(panel));
        if (ratio < worst.ratio) worst = { ratio, name, label, m, alpha: s.alpha };
      }
    }
  }
}
const hh = String(Math.floor(worst.m / 60)).padStart(2, '0') + ':' + String(worst.m % 60).padStart(2, '0');
check(worst.ratio >= 4.5,
  `worst case ${worst.ratio.toFixed(2)}:1 (${worst.name} at ${hh}, ${worst.label}, panel alpha ${worst.alpha.toFixed(2)}) >= 4.5:1`);

/* ---- 3. bin lid contrast ------------------------------------------ */
console.log('\nBin lid colours');
for (const [lid, on, name] of [
  ['#c4382e', '#ffffff', 'red / white'],
  ['#2f7a45', '#ffffff', 'green / white'],
  ['#eec32e', '#241c02', 'yellow / near-black'],
]) {
  const r = contrast(M.luminance(M.hexToRgb(lid)), M.luminance(M.hexToRgb(on)));
  check(r >= 4.5, `${name} ${r.toFixed(2)}:1`);
}

/* ---- 4. the sky actually moves ------------------------------------ */
console.log('\nSky');
const at = (m) => M.skyAt(m, 390, 1065);
const [night, dawn, noon, dusk] = [180, 400, 720, 1080].map(at);
const spread = Math.max(...[night, noon].map((s) => M.luminance(s.stops[1]))) -
               Math.min(...[night, noon].map((s) => M.luminance(s.stops[1])));
check(spread > 0.15, `midnight to midday luminance spread ${spread.toFixed(3)}`);
check(night.alpha < noon.alpha, `panel opens up at night (${night.alpha.toFixed(2)}) vs midday (${noon.alpha.toFixed(2)})`);
check(dawn.gradient !== dusk.gradient, 'dawn and dusk are different palettes');

/* ---- 5. constraints that are easy to regress ---------------------- */
console.log('\nHard constraints');
check(!/localStorage|sessionStorage|document\.cookie/.test(script), 'no browser storage');
check(!/<script[^>]+src=/.test(html), 'no external script');
check(/prefers-reduced-motion/.test(html), 'prefers-reduced-motion honoured');
check(/tabular-nums/.test(html), 'tabular numerals');
check((html.match(/<style>/g) || []).length === 1 && (html.match(/<script>/g) || []).length === 1,
  'one style block, one script block');
check(/Intl\.DateTimeFormat/.test(script) && /timeZone/.test(script), 'dates go through Intl with a zone');

console.log(fails ? `\n${fails} check(s) failed\n` : '\nall checks passed\n');
process.exitCode = fails ? 1 : 0;
