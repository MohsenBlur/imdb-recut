// Exercises the REAL Rotten Tomatoes functions, sliced out of the userscript
// source (not copy-pasted), against live Rotten Tomatoes and Wikidata.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const PATH = fileURLToPath(new URL('../recut.user.js', import.meta.url));
const SRC = fs.readFileSync(PATH, 'utf8');
const LINES = SRC.split(/\r?\n/);

// Top-level functions sit two spaces deep inside the IIFE, so their closing
// brace is a line that is exactly two spaces and a brace. That boundary is far
// more reliable than counting braces, which would trip over braces in strings.
function sliceFn(name) {
  const head = new RegExp('^  (?:async )?function ' + name + '\\(');
  const i = LINES.findIndex((l) => head.test(l));
  if (i < 0) throw new Error('function ' + name + ' not found');
  for (let j = i + 1; j < LINES.length; j++) {
    if (LINES[j] === '  }') return LINES.slice(i, j + 1).join('\n');
  }
  throw new Error('no closing brace found for ' + name);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
async function netGet(url, { headers = {} } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers } });
  if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status + ' from ' + url);
  return r.text();
}
const warn = (...a) => console.log('   warn:', ...a);

const NAMES = ['normaliseTitleForMatch', 'rtSlugFromSearch', 'rtScores'];
const body = NAMES.map(sliceFn).join('\n\n');
const M = new Function('netGet', 'DOMParser', 'warn', body + '\nreturn {' + NAMES.join(',') + '};')(netGet, DOMParser, warn);

const CASES = [
  { label: 'movie, exact title', imdb: 'tt0120737', title: 'The Lord of the Rings: The Fellowship of the Ring', year: 2001, isSeries: false, cast: ['Elijah Wood'], expectSlug: 'm/the_lord_of_the_rings_the_fellowship_of_the_ring' },
  { label: 'tv series', imdb: 'tt11041332', title: 'Yellowjackets', year: 2021, isSeries: true, cast: ['Melanie Lynskey'] },
  { label: 'not on RT at all', imdb: 'tt2624370', title: 'Granite Flats', year: 2013, isSeries: true, cast: ['Christopher Lloyd'], expectNull: true },
  { label: 'remake ambiguity', imdb: 'tt0087332', title: 'Ghostbusters', year: 1984, isSeries: false, cast: ['Bill Murray'] },
  { label: 'one-word title', imdb: 'tt0816692', title: 'Interstellar', year: 2014, isSeries: false, cast: ['Matthew McConaughey'] },
  { label: 'subtitle + colon, tv', imdb: 'tt0903747', title: 'Breaking Bad', year: 2008, isSeries: true, cast: ['Bryan Cranston'] },
];

console.log('=== Live Wikidata -> Rotten Tomatoes slug -> scorecard ===\n');
let pass = 0, fail = 0;
for (const c of CASES) {
  let search = null, scores = null, err = null;
  try { search = await M.rtSlugFromSearch(c); } catch (e) { err = 'search: ' + e.message; }
  const slug = search;
  if (slug) { try { scores = await M.rtScores(slug); } catch (e) { err = (err ? err + ' / ' : '') + 'scores: ' + e.message; } }

  console.log(`${c.label}  [${c.imdb}] ${c.title} (${c.year})`);
  console.log(`   search slug   : ${search || '(none)'}`);
  console.log(`   critics       : ${scores && scores.critics ? scores.critics.score + '%  ' + scores.critics.count + ' reviews' + (scores.critics.certified ? '  CERTIFIED' : '') : '(none)'}`);
  console.log(`   audience      : ${scores && scores.audience ? scores.audience.score + '%  ' + (scores.audience.banded || scores.audience.count) : '(none)'}`);
  if (err) console.log('   ERR: ' + err);
  if (c.expectSlug) { const ok = slug === c.expectSlug; ok ? pass++ : fail++; console.log(`   expect ${c.expectSlug} -> ${ok ? 'PASS' : 'FAIL (got ' + slug + ')'}`); }
  if (c.expectNull) { const ok = !slug; ok ? pass++ : fail++; console.log(`   expect no match -> ${ok ? 'PASS' : 'FAIL (matched ' + slug + ')'}`); }
  console.log('');
}

console.log('=== Known-bad probes: the matcher must refuse rather than guess ===');
const bogus = await M.rtSlugFromSearch({ title: 'Zzqx Nonexistent Film That Cannot Exist', year: 1999, isSeries: false, cast: [] });
(bogus === null ? pass++ : fail++);
console.log('  invented title        ->', bogus === null ? 'PASS (refused)' : 'FAIL (matched ' + bogus + ')');

const wrongYear = await M.rtSlugFromSearch({ title: 'Ghostbusters', year: 1922, isSeries: false, cast: [] });
console.log('  Ghostbusters as 1922  ->', wrongYear === null ? 'refused' : 'matched ' + wrongYear + '  (year penalty was not decisive)');

console.log('\n=== normaliseTitleForMatch ===');
for (const s of ['The Lord of the Rings: The Fellowship of the Ring', 'WALL·E', 'Amélie', 'Fast & Furious', 'A Quiet Place']) {
  console.log(`  ${JSON.stringify(s)} -> ${JSON.stringify(M.normaliseTitleForMatch(s))}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
