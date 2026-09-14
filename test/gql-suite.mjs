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
  // Order matters: these are concatenated as written, so anything a template
  // literal interpolates has to be declared before it - the same temporal
  // dead zone the script itself has to respect.
  'ROLE_SHOWN', 'ROLE_FETCH', 'roleList',
  'GQL_ENDPOINT', 'GQL_HEADERS', 'CAST_FIELDS', 'PERSON_CREDIT_FIELDS', 'REVIEW_SORTS',
  'edges', 'gqlStr', 'num', 'compactNum', 'runtimeText', 'yearText', 'imgSize',
  'GQL_URL_MAX',
  'gql', 'normaliseTitleCard', 'normaliseCastFromGraphql', 'normalisePersonCredit',
  'normaliseReview', 'creditCategories', 'dedupeCredits',
  'fetchFullCast', 'fetchReviews', 'fetchSeasonStats', 'fetchAllCredits',
];

const EXPORTS = ['creditCategories', 'gql', 'fetchFullCast', 'fetchReviews', 'fetchSeasonStats', 'fetchAllCredits', 'REVIEW_SORTS', 'GQL_HEADERS', 'GQL_URL_MAX', 'roleList', 'ROLE_SHOWN', 'ROLE_FETCH'];
const body = DECLS.map(sliceDecl).join('\n\n');

let calls = 0;
let posts = 0;
async function netGet(url, { headers = {} } = {}) {
  calls++;
  const r = await fetch(url, { headers });
  if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status + ' from ' + url.slice(0, 110));
  return r.text();
}
async function netPost(url, data, { headers = {} } = {}) {
  calls++;
  posts++;
  const r = await fetch(url, { method: 'POST', body: data, headers });
  if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status + ' from ' + url);
  return r.text();
}
const M_ = new Function('netGet', 'netPost', body + '\nreturn {' + EXPORTS.join(',') + '};')(netGet, netPost);
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

// ── per-season counts and ratings, including a very long series ─────────
console.log('\n[fetchSeasonStats]');
{
  const gf = await M.fetchSeasonStats('tt2624370', ['1', '2', '3']);
  check('Granite Flats 9/9/9',
    gf['1'].episodes === 9 && gf['2'].episodes === 9 && gf['3'].episodes === 9,
    Object.entries(gf).map(([k, v]) => `${k}:${v.episodes}`).join(' '));

  // 40 seasons, not 36: at 36 the GET URL is 7,942 characters and squeaks
  // under IMDb's 8 KB ceiling, at 40 it is 8,814 and comes back 414. The real
  // show has 40, which is exactly how the ceiling was found - so the test uses
  // the number that actually breaks it.
  const many = Array.from({ length: 40 }, (_, i) => String(i + 1));
  const before = posts;
  const simpsons = await M.fetchSeasonStats('tt0096697', many);
  const got = Object.keys(simpsons).length;
  const sum = Object.values(simpsons).reduce((a, v) => a + (v.episodes || 0), 0);
  check('The Simpsons: 40 aliased seasons in one request', got === 40, `${got} seasons, ${sum} episodes total`);
  check('a query too long for a URL goes out as a POST instead of 414ing',
    posts === before + 1, `${posts - before} POSTs`);

  // IMDb publishes no season rating, so it is the mean of the season's own
  // episodes. The Simpsons is the test case because its decline is the whole
  // reason anyone wants the number: the early seasons must beat the late ones.
  const mean = (n) => simpsons[String(n)] && simpsons[String(n)].rating;
  const scored = Object.values(simpsons).filter((v) => typeof v.rating === 'number');
  check('the seasons that have aired all carry a rating', scored.length >= 35, `${scored.length}/40`);
  check('the mean is a 0-10 rating, not a vote count',
    scored.every((v) => v.rating > 0 && v.rating <= 10),
    `S1 ${mean(1).toFixed(2)} · S7 ${mean(7).toFixed(2)} · S36 ${mean(36).toFixed(2)}`);
  check('the golden age outranks the late run by more than a rounding error',
    mean(7) - mean(36) > 1, `S7 ${mean(7).toFixed(2)} vs S36 ${mean(36).toFixed(2)}`);
  check('rated never exceeds the episode count',
    scored.every((v) => v.rated <= v.episodes), JSON.stringify(simpsons['1']));

  // The Simpsons has seasons listed and scheduled but not yet aired: episodes,
  // no ratings. Those must come back with no rating at all rather than a mean
  // of nothing - which is NaN, and NaN.toFixed(1) renders the word "NaN".
  const unaired = Object.values(simpsons).filter((v) => v.episodes > 0 && v.rated === undefined);
  check('a listed but unaired season has episodes and no rating',
    unaired.length > 0 && unaired.every((v) => v.rating === undefined),
    `${unaired.length} unaired, ${unaired.reduce((a, v) => a + v.episodes, 0)} episodes listed`);
  check('no season reports a NaN rating',
    Object.values(simpsons).every((v) => v.rating === undefined || Number.isFinite(v.rating)));
  check('votes are per episode, not summed across the season',
    simpsons['1'].votes < 100000, `S1 ${simpsons['1'].votes} votes/episode over ${simpsons['1'].rated} episodes`);

  // A season can hold an episode nobody has rated - Game of Thrones S1 does -
  // and the count has to reflect that rather than quietly averaging a zero.
  const got8 = await M.fetchSeasonStats('tt0944947', ['1', '8']);
  check('an unrated episode is excluded, not counted as zero',
    got8['1'].rated <= got8['1'].episodes && got8['1'].rating > 8,
    `S1 ${got8['1'].rated}/${got8['1'].episodes} rated, mean ${got8['1'].rating.toFixed(2)}`);
  check('a collapse in quality shows up as a collapse in the number',
    got8['1'].rating - got8['8'].rating > 2,
    `S1 ${got8['1'].rating.toFixed(1)} vs S8 ${got8['8'].rating.toFixed(1)}`);

  const empty = await M.fetchSeasonStats('tt0120737', []);
  check('no seasons -> no request, empty object', JSON.stringify(empty) === '{}');

  // The switch has to stay on the GET side for ordinary queries: a POST is not
  // cacheable, and every other call in this file is small.
  const shortPosts = posts;
  await M.gql('{ title(id: "tt0903747") { titleText { text } } }');
  check('a short query still goes out as a GET', posts === shortPosts);
  check(`the switch sits below IMDb's ceiling`, M.GQL_URL_MAX < 7942, `GQL_URL_MAX=${M.GQL_URL_MAX}`);
}

// ── a role list that runs to four figures ───────────────────────────
console.log('\n[characters] tt0096697 (The Simpsons) — one voice, 1,299 parts');
{
  // Unbounded, one cast page of this show is 207 KB because a handful of voice
  // actors carry four-figure character lists - Dan Castellaneta has 1,299 and
  // one other has 1,620. Rendered whole, his card came out 25,758 pixels tall
  // and, since grid rows share a height, took the cast section to 46,000.
  const cast = await M.fetchFullCast('tt0096697', 60);
  const worst = cast.reduce((a, c) => Math.max(a, c.characters.length), 0);
  check('no character list comes back longer than the cap',
    worst <= M.ROLE_FETCH, `longest is ${worst}, cap is ${M.ROLE_FETCH}`);
  check('the cap is not so tight it flattens ordinary roles',
    cast.some((c) => c.characters.length > 1));

  const homer = cast.find((c) => c.name === 'Dan Castellaneta');
  check('the famous case is present and capped', !!homer && homer.characters.length === M.ROLE_FETCH,
    homer ? `${homer.characters.length} characters` : 'not in the first 60');

  const shown = M.roleList(homer.characters);
  check('only a readable handful is printed',
    shown.text.split(' / ').length === M.ROLE_SHOWN, shown.text);
  check('a list sitting on the cap does not claim a total it does not have',
    shown.more === '+ more', shown.more);
  check('a list we hold in full reports the real remainder',
    M.roleList(Array.from({ length: 1299 }, (_, i) => 'Role ' + i)).more === '+1,295 more',
    M.roleList(Array.from({ length: 1299 }, (_, i) => 'Role ' + i)).more);
  check('a short list is printed whole with nothing appended',
    M.roleList(['Homer', 'Krusty']).text === 'Homer / Krusty' && M.roleList(['Homer', 'Krusty']).more === '');
  check('no characters yields no text', M.roleList([]).text === '' && M.roleList(undefined).text === '');
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
