// Checks the Letterboxd button's type gating and URL building, using the real
// functions sliced out of the userscript, plus a live check that Letterboxd's
// /imdb/ redirect still behaves the way the gating assumes.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../recut.user.js', import.meta.url));
const LINES = fs.readFileSync(PATH, 'utf8').split(/\r?\n/);

function balanced(text) {
  let d = 0, tick = 0;
  for (const ch of text) {
    if (ch === '`') tick ^= 1;
    if (tick) continue;
    if (ch === '(' || ch === '{' || ch === '[') d++;
    else if (ch === ')' || ch === '}' || ch === ']') d--;
  }
  return d === 0 && tick === 0;
}

function sliceDecl(name) {
  const fnHead = new RegExp('^  (?:async )?function ' + name + '\\(');
  const constHead = new RegExp('^  const ' + name + '\\b');
  const i = LINES.findIndex((l) => fnHead.test(l) || constHead.test(l));
  if (i < 0) throw new Error('not found: ' + name);
  if (fnHead.test(LINES[i])) {
    for (let j = i + 1; j < LINES.length; j++) if (LINES[j] === '  }') return LINES.slice(i, j + 1).join('\n');
    throw new Error('no end for ' + name);
  }
  for (let j = i; j < Math.min(i + 200, LINES.length); j++) {
    const text = LINES.slice(i, j + 1).join('\n');
    if (LINES[j].trimEnd().endsWith(';') && balanced(text)) return text;
  }
  throw new Error('no end for const ' + name);
}

const PRE = `
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const RAW = Symbol('raw');
  const raw = (s) => ({ [RAW]: true, s: String(s) });
  function interpolate(v) {
    if (v === null || v === undefined || v === false) return '';
    if (Array.isArray(v)) return v.map(interpolate).join('');
    if (typeof v === 'object' && v[RAW]) return v.s;
    return esc(v);
  }
  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
    return raw(out);
  }
  // This suite is about the Letterboxd button; the media chips that share the
  // same row have their own coverage.
  const mediaButtons = () => '';
`;

const NAMES = ['MARKS', 'LETTERBOXD_TYPES', 'letterboxdRedirect', 'actionsHtml'];
const M = new Function(PRE + NAMES.map(sliceDecl).join('\n\n') + '\nreturn {LETTERBOXD_TYPES, letterboxdRedirect, letterboxdButton: (t) => actionsHtml(t)};')();

let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

console.log('[type gating] the button must appear for films and ONLY for films');
const SHOULD = ['movie', 'tvMovie', 'short', 'tvShort', 'video', 'tvSpecial'];
const SHOULD_NOT = ['tvSeries', 'tvMiniSeries', 'tvEpisode', 'videoGame', 'musicVideo', 'podcastSeries', 'podcastEpisode', ''];
for (const typeId of SHOULD) {
  const out = M.letterboxdButton({ id: 'tt0120737', typeId });
  check(`shown for ${typeId || '(empty)'}`, !!out && out.includes('letterboxd.com/imdb/tt0120737/'));
}
for (const typeId of SHOULD_NOT) {
  const out = M.letterboxdButton({ id: 'tt2624370', typeId });
  check(`hidden for ${typeId || '(empty type)'}`, out === '', JSON.stringify(out).slice(0, 40));
}

console.log('\n[markup]');
const btn = M.letterboxdButton({ id: 'tt0816692', typeId: 'movie' });
check('links to the id redirect', btn.includes('href="https://letterboxd.com/imdb/tt0816692/"'));
check('opens in a new tab safely', btn.includes('target="_blank"') && btn.includes('rel="noopener noreferrer"'));
check('carries the hook the resolver looks for', btn.includes('data-imdbc-lbx'));
const hostile = M.letterboxdButton({ id: 'tt1"><script>alert(1)</script>', typeId: 'movie' });
check('a hostile id cannot break out of the attribute', !hostile.includes('<script>'), hostile.slice(0, 120));

console.log('\n[live] Letterboxd /imdb/<id>/ still behaves as the gating assumes');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
async function resolve(id) {
  const r = await fetch('https://letterboxd.com/imdb/' + id + '/', { headers: { 'User-Agent': UA }, redirect: 'follow' });
  return { status: r.status, url: r.url };
}
for (const [label, id, expectFilm] of [
  ['a feature', 'tt0120737', true],
  ['a short', 'tt0000012', true],
  ['a TV series', 'tt2624370', false],
  ['an episode', 'tt2301455', false],
  ['a nonexistent id', 'tt99999999', false]
]) {
  try {
    const r = await resolve(id);
    const isFilm = /letterboxd\.com\/film\/[^/?#]+/.test(r.url);
    check(`${label} -> ${expectFilm ? 'film page' : 'no film page'}`, isFilm === expectFilm, r.url.replace('https://letterboxd.com', ''));
  } catch (e) { check(label, false, e.message); }
}

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
