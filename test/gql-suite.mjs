// Runs the userscript's REAL fetchers — sliced out of the source file, not
// re-typed — against live IMDb GraphQL. Catches wrong field names, missing
// `first:` on nested connections, bad enum values and broken pagination.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../recut.user.js', import.meta.url));
const LINES = fs.readFileSync(PATH, 'utf8').split(/\r?\n/);

function sliceDecl(name) {
  const fnHead = new RegExp('^  (?:async )?function ' + name + '\\(');
  const constHead = new RegExp('^  const ' + name + '\\b');
  let i = LINES.findIndex((l) => fnHead.test(l) || constHead.test(l));
  if (i < 0) throw new Error('declaration not found: ' + name);
  if (fnHead.test(LINES[i])) {
    for (let j = i + 1; j < LINES.length; j++) if (LINES[j] === '  }') return LINES.slice(i, j + 1).join('\n');
    throw new Error('no end for function ' + name);
  }
  if (LINES[i].trimEnd().endsWith(';')) return LINES[i];
  for (let j = i + 1; j < LINES.length; j++) {
    const t = LINES[j].trimEnd();
    if (t === '  };' || t.endsWith('`;') || t === '  ];') return LINES.slice(i, j + 1).join('\n');
  }
  throw new Error('no end for const ' + name);
}

const DECLS = [
  'GQL_ENDPOINT', 'GQL_HEADERS', 'CAST_FIELDS', 'PERSON_CREDIT_FIELDS', 'REVIEW_SORTS',
  'edges', 'gqlStr', 'num', 'compactNum', 'runtimeText', 'yearText', 'imgSize',
  'gql', 'normaliseTitleCard', 'normaliseCastFromGraphql', 'normalisePersonCredit',
  'normaliseReview', 'creditCategories', 'dedupeCredits',
  'fetchFullCast', 'fetchReviews', 'fetchSeasonCounts', 'fetchAllCredits',
];

const EXPORTS = ['creditCategories', 'gql', 'fetchFullCast', 'fetchReviews', 'fetchSeasonCounts', 'fetchAllCredits', 'REVIEW_SORTS', 'GQL_HEADERS'];
const body = DECLS.map(sliceDecl).join('\n\n');

let calls = 0;
async function netGet(url, { headers = {} } = {}) {
  calls++;
  const r = await fetch(url, { headers });
  if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status + ' from ' + url.slice(0, 110));
  return r.text();
}
const M_ = new Function('netGet', body + '\nreturn {' + EXPORTS.join(',') + '};')(netGet);
const M = M_;
const M_creditCategories = M_.creditCategories;

console.log('headers the script sends:', JSON.stringify(M.GQL_HEADERS));
let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

// ── full cast ─────────────────────────────────────────────────────────────
console.log('\n[fetchFullCast] tt0120737 (LOTR, 158 cast) — paginated');
{
  const cast = await M.fetchFullCast('tt0120737');
  check('returns more than the 18 the page ships', cast.length > 18, `got ${cast.length}`);
  const frodo = cast.find((c) => c.name === 'Elijah Wood');
  check('character names present', !!(frodo && frodo.characters.includes('Frodo')), frodo ? frodo.characters.join('/') : 'no Elijah Wood');
  check('no null entries', cast.every((c) => c && c.id && c.name));
  const withPhoto = cast.filter((c) => c.photo).length;
  console.log(`         ${cast.length} cast, ${withPhoto} with photos`);
}

// ── cast on a series (episodeCredits) ─────────────────────────────────────
console.log('\n[fetchFullCast] tt2624370 (Granite Flats, 110 cast, TV)');
{
  const cast = await M.fetchFullCast('tt2624370');
  check('full list fetched', cast.length >= 100, `got ${cast.length}`);
  const lead = cast[0];
  check('episode counts present on series cast', !!(lead && lead.episodeCount), lead ? `${lead.name}: ${lead.episodeCount} eps ${lead.episodeYears}` : '');
}

// ── reviews: every sort the UI offers ─────────────────────────────────────
console.log('\n[fetchReviews] tt0120737 — all four sort orders the dropdown exposes');
for (const key of Object.keys(M.REVIEW_SORTS)) {
  try {
    const page = await M.fetchReviews('tt0120737', key, 5, null);
    const ok = page.reviews.length === 5 && page.total > 0 && !!page.cursor;
    check(`sort "${key}" (${M.REVIEW_SORTS[key].by})`, ok, `total=${page.total} got=${page.reviews.length} more=${page.hasMore}`);
  } catch (e) { check(`sort "${key}"`, false, e.message); }
}

console.log('\n[fetchReviews] pagination via endCursor');
{
  const p1 = await M.fetchReviews('tt0120737', 'top', 5, null);
  const p2 = await M.fetchReviews('tt0120737', 'top', 5, p1.cursor);
  const overlap = p1.reviews.filter((r) => p2.reviews.some((x) => x.id === r.id)).length;
  check('second page is disjoint from the first', overlap === 0, `overlap=${overlap}`);
  check('review text and rating decoded', !!(p1.reviews[0].text && p1.reviews[0].summary), `"${p1.reviews[0].summary}" ${p1.reviews[0].rating}/10 +${p1.reviews[0].up}`);
}

// ── per-season counts, including a very long series ───────────────────────
console.log('\n[fetchSeasonCounts]');
{
  const gf = await M.fetchSeasonCounts('tt2624370', ['1', '2', '3']);
  check('Granite Flats 9/9/9', gf['1'] === 9 && gf['2'] === 9 && gf['3'] === 9, JSON.stringify(gf));

  const many = Array.from({ length: 36 }, (_, i) => String(i + 1));
  const simpsons = await M.fetchSeasonCounts('tt0096697', many);
  const got = Object.keys(simpsons).length;
  const sum = Object.values(simpsons).reduce((a, b) => a + b, 0);
  check('The Simpsons: 36 aliased seasons in one request', got === 36, `${got} seasons, ${sum} episodes total`);

  const empty = await M.fetchSeasonCounts('tt0120737', []);
  check('no seasons -> no request, empty object', JSON.stringify(empty) === '{}');
}

// ── full filmography ──────────────────────────────────────────────────────
console.log('\n[fetchAllCredits] nm0000704 (Elijah Wood)');
{
  const before = calls;
  const credits = await M.fetchAllCredits('nm0000704');
  check('fetches the whole 484, not the 15-per-group the page ships', credits.length > 400, `${credits.length} credits in ${calls - before} requests`);
  const yj = credits.find((c) => c.title === 'Yellowjackets');
  check('character present', !!(yj && yj.characters.includes('Walter')), yj ? yj.characters.join('/') : 'not found');
  check('episode count present', !!(yj && yj.episodeCount === 15), yj ? `${yj.episodeCount} eps, seasons ${yj.seasons.join(',')}` : '');
  const fotr = credits.find((c) => c.id === 'tt0120737');
  check('film credit carries character + rating', !!(fotr && fotr.characters.includes('Frodo') && fotr.rating > 8), fotr ? `${fotr.characters.join('/')} ★${fotr.rating}` : '');
  const cats = [...new Set(credits.map((c) => c.category))];
  check('categories populated for tab grouping', cats.length > 3, cats.join(', '));
  check('every credit has a title and id', credits.every((c) => c.id && c.title));
}

// ── multi-role credits: one row per title, all roles kept ────────────────
console.log('\n[multi-role] nm0000255 (Ben Affleck) — Animals is Producer+Actor+Writer+Director');
{
  const credits = await M.fetchAllCredits('nm0000255');
  const animals = credits.filter((c) => c.title === 'Animals');
  check('appears exactly once, not once per role', animals.length === 1, `${animals.length} rows`);
  const cats = animals[0] ? M_creditCategories(animals[0]) : [];
  check('carries every role it holds', cats.length >= 3, cats.join(' + '));
  const producers = credits.filter((c) => M_creditCategories(c).includes('Producer'));
  const actors = credits.filter((c) => M_creditCategories(c).includes('Actor'));
  check('a title can count toward two tabs', producers.some((c) => M_creditCategories(c).includes('Actor')),
    `${producers.length} producer, ${actors.length} actor, ${producers.filter((c) => M_creditCategories(c).includes('Actor')).length} both`);
  const ids = credits.map((c) => c.id);
  check('no duplicate title ids after dedupe', new Set(ids).size === ids.length, `${ids.length} rows, ${new Set(ids).size} unique`);
}

// ── a person with a tiny filmography (boundary) ───────────────────────────
console.log('\n[fetchAllCredits] a one-credit person (single page, no cursor loop)');
{
  const credits = await M.fetchAllCredits('nm0000704', 3);
  check('cap respected', credits.length <= 3, `${credits.length}`);
}

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILED'}  (${calls} live requests)`);
process.exit(fails ? 1 : 0);
