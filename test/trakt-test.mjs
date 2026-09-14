// Trakt + Wikidata resolution, using the real functions sliced out of the
// userscript, against live Wikidata.
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

const store = new Map();
let requests = 0;
async function netGet(url, { headers = {} } = {}) {
  requests++;
  const r = await fetch(url, { headers: { 'User-Agent': 'imdb-clean-test/1.0', ...headers } });
  if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status);
  return r.text();
}
const PRE = `
  const warn = () => {};
  const diskGet = (k) => (store.has(k) ? { value: store.get(k) } : null);
  const diskSet = (k, v) => store.set(k, v);
`;
const NAMES = ['WD_TTL_HIT', 'WD_TTL_MISS', 'wdInFlight', 'wikidataIds', 'fetchWikidataIds', 'TRAKT_UNSUPPORTED', 'traktUrl'];
const M = new Function('netGet', 'store', PRE + NAMES.map(sliceDecl).join('\n\n') + '\nreturn {wikidataIds, traktUrl};')(netGet, store);

let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

console.log('[resolution] Trakt covers far more title types than Letterboxd');
const CASES = [
  ['a movie', 'tt0120737', 'movie', '/movies/'],
  ['another movie', 'tt0816692', 'movie', '/movies/'],
  ['a TV series', 'tt0903747', 'tvSeries', '/shows/'],
  ['a mini series', 'tt7366338', 'tvMiniSeries', '/shows/'],
  ['a TV episode', 'tt2301455', 'tvEpisode', '/shows/breaking-bad'],
  ['an obscure series', 'tt2624370', 'tvSeries', '/shows/'],
  ['a 19th-century short', 'tt0000012', 'short', '/movies/']
];
for (const [label, id, typeId, expect] of CASES) {
  const url = await M.traktUrl(id, typeId);
  check(`${label} resolves`, !!url && url.includes(expect), url || '(none)');
}

{
  // Trakt's web app has no episode pages: it redirects an episode deep-link to
  // the show, bouncing through a sign-in check on the way. The link must
  // therefore already BE the show url - verified in a real browser.
  const ep = await M.traktUrl('tt2301455', 'tvEpisode');
  check('an episode links straight to the show, with no season/episode path',
    ep === 'https://trakt.tv/shows/breaking-bad', ep || '(none)');
  check('no episode deep-link can survive', !/seasons|episodes/.test(ep || ''), ep || '');
}

console.log('\n[refusal] it must never invent a link');
{
  const bogus = await M.traktUrl('tt99999999', 'movie');
  check('an unknown id yields no link', bogus === null, String(bogus));
  const malformed = await M.traktUrl('not-an-id', 'movie');
  check('a malformed id yields no link', malformed === null, String(malformed));
  for (const t of ['videoGame', 'podcastSeries', 'podcastEpisode', 'musicVideo']) {
    const r = await M.traktUrl('tt0120737', t);
    check(`${t} is not offered a Trakt link`, r === null, String(r));
  }
}

console.log('\n[shared lookup] one Wikidata request serves both destinations');
{
  store.clear();
  const before = requests;
  const ids = await M.wikidataIds('tt0120737');
  const after = requests;
  check('one request only', after - before === 1, `${after - before} requests`);
  check('Rotten Tomatoes id returned', !!ids.rt && /^m\//.test(ids.rt), ids.rt || '(none)');
  check('Trakt id returned', !!ids.trakt && /^movies\//.test(ids.trakt), ids.trakt || '(none)');

  const cachedBefore = requests;
  await M.wikidataIds('tt0120737');
  check('a second call is served from cache', requests === cachedBefore, `${requests - cachedBefore} extra requests`);
}

console.log('\n[shape] a TV id must not be mistaken for a movie id');
{
  store.clear();
  const bb = await M.wikidataIds('tt0903747');
  check('Breaking Bad resolves to shows/, not movies/', bb.trakt === 'shows/breaking-bad', bb.trakt || '(none)');
  check('and its Rotten Tomatoes id is a tv/ one', !!bb.rt && /^tv\//.test(bb.rt), bb.rt || '(none)');
}

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILED'}  (${requests} live requests)`);
process.exit(fails ? 1 : 0);
