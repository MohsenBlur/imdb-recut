// Builds preview.html from the userscript's REAL render functions, REAL
// stylesheet and REAL IMDb data. Chrome will not make a window narrower than
// ~500px, so this is how the phone layout actually gets looked at: open the
// generated file at any viewport width.
//
//   node preview.mjs           -> writes preview.html
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../recut.user.js', import.meta.url));
const SRC = fs.readFileSync(PATH, 'utf8');
const LINES = SRC.split(/\r?\n/);

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
  for (let j = i; j < Math.min(i + 400, LINES.length); j++) {
    const text = LINES.slice(i, j + 1).join('\n');
    if (LINES[j].trimEnd().endsWith(';') && balanced(text)) return text;
  }
  throw new Error('no end for const ' + name);
}

// the stylesheet, verbatim
const cssStart = SRC.indexOf('const CSS = `') + 'const CSS = `'.length;
const cssEnd = SRC.indexOf('\n`;', cssStart);
const CSS = SRC.slice(cssStart, cssEnd);

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
  function safeUrl(u) {
    if (!u) return '';
    const s = String(u).trim();
    if (/^https?:\\/\\//i.test(s)) return s;
    if (/^\\/(?!\\/)/.test(s)) return 'https://www.imdb.com' + s;
    return '';
  }
  const settings = { rottenTomatoes: true, hideSelfCredits: true };
  const warn = () => {};
`;

const NAMES = [
  'num', 'compactNum', 'runtimeText', 'yearText', 'imdbDateText', 'reviewDateText',
  'RATING_BANDS', 'ratingBand', 'THIN_VOTES', 'ratingClasses',
  'imgSize', 'thumb', 'titleUrl', 'nameUrl', 'initials',
  'MARKS', 'LETTERBOXD_TYPES', 'scoreTile', 'pendingTile', 'scoreStrip',
  'sectionHead', 'personCard', 'titleCard', 'knownForCard', 'creditCategories', 'creditRow',
  'reviewCard', 'findUrl', 'normaliseSearch', 'searchTitleRow', 'searchNameRow',
  'edges', 'gqlStr', 'normaliseTitleCard', 'normaliseCastFromGraphql', 'normalisePersonCredit',
  'dedupeCredits', 'normaliseReview', 'GQL_ENDPOINT', 'GQL_HEADERS', 'gql',
  'CAST_FIELDS', 'PERSON_CREDIT_FIELDS', 'REVIEW_SORTS',
  'fetchFullCast', 'fetchAllCredits', 'fetchReviews'
];
const EXPORTS = ['interpolate', 'normaliseSearch', 'scoreStrip', 'sectionHead', 'personCard', 'titleCard', 'knownForCard',
  'creditRow', 'reviewCard', 'searchTitleRow', 'searchNameRow', 'thumb',
  'fetchFullCast', 'fetchAllCredits', 'fetchReviews'];

async function netGet(url, { headers = {} } = {}) {
  const r = await fetch(url, { headers });
  if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status);
  return r.text();
}
const M = new Function('netGet', PRE + NAMES.map(sliceDecl).join('\n\n') + '\nreturn {' + EXPORTS.join(',') + '};')(netGet);

console.log('fetching real data from IMDb...');
const [cast, credits, reviews] = await Promise.all([
  M.fetchFullCast('tt0120737', 12),
  M.fetchAllCredits('nm0000276', 250),
  M.fetchReviews('tt0120737', 'top', 3, null)
]);
console.log(`  ${cast.length} cast, ${credits.length} credits, ${reviews.reviews.length} reviews`);

// A title shaped exactly as normaliseTitle produces, with every score present.
const title = {
  id: 'tt0120737', typeId: 'movie', title: 'The Lord of the Rings: The Fellowship of the Ring',
  rating: 8.9, votes: 2236310, topRank: 8, metascore: 92,
  rt: { url: 'https://www.rottentomatoes.com/m/x', critics: { score: 91, count: 271, certified: true }, audience: { score: 95, banded: '250,000+ Ratings' } },
  lbx: { url: 'https://letterboxd.com/film/x/', rating: 4.4, count: 3252529, best: 5 }
};
// A second strip exercising the low bands.
const weak = { id: 'tt0060666', typeId: 'movie', title: 'weak', rating: 1.9, votes: 87000, metascore: 21,
  rt: { url: '#', critics: { score: 24, count: 41, certified: false }, audience: { score: 38, banded: '2,500+ Ratings' } },
  lbx: { url: '#', rating: 1.4, count: 41000, best: 5 } };
const mid = { id: 'tt0000001', typeId: 'movie', title: 'mid', rating: 6.4, votes: 12000, metascore: 55,
  rt: { url: '#', critics: { score: 64, count: 120, certified: false }, audience: { score: 72, banded: '50,000+ Ratings' } },
  lbx: { url: '#', rating: 3.3, count: 9000, best: 5 } };

const searchSample = M.normaliseSearch({
  findPageMeta: { searchTerm: 'lord of the rings' },
  titleResults: { nextCursor: 'x', results: credits.slice(0, 3).map((c) => ({ index: c.id, listItem: {
    titleId: c.id, titleText: c.title, titleType: { id: c.typeId, text: c.typeText }, releaseYear: c.startYear,
    genres: c.genres, plot: 'A sample plot line long enough to wrap onto a second line so the clamp and measure can be judged properly at this width.',
    primaryImage: { url: c.poster, width: 1000, height: 1500 }, ratingSummary: { aggregateRating: c.rating, voteCount: c.votes }
  } })) },
  nameResults: { results: [{ index: 'nm0000276', listItem: {
    nameId: 'nm0000276', nameText: 'Sean Bean', professions: ['Actor', 'Producer', 'Additional Crew'],
    primaryImage: { url: cast[0] && cast[0].photo, width: 1000, height: 1400 },
    knownFor: { titleId: 'tt0120737', titleText: 'The Lord of the Rings: The Fellowship of the Ring', yearRange: { year: 2001 } }
  } }] }
}, { query: 'lord of the rings', section: '' });

const I = M.interpolate;
const section = (h, body, count) => `<section class="imdbc-sec">${I(M.sectionHead(h, count === undefined ? '' : count))}${body}</section>`;

const page = `<!doctype html>
<html lang="en" class="imdbc-on imdbc-dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IMDb Clean - layout preview</title>
<style>${CSS}</style>
<style>
  body { margin: 0; }
  .ruler { position: sticky; top: 0; z-index: 99; background: #000; color: #8f8; font: 600 12px monospace; padding: 4px 8px; }
</style>
</head><body>
<div class="ruler" id="ruler">width</div>
<div id="imdbc-root">
  <div class="imdbc-wrap">
    ${section('Score tiles: high', `<div class="imdbc-scores">${M.scoreStrip(title)}</div>`)}
    ${section('Score tiles: middling', `<div class="imdbc-scores">${M.scoreStrip(mid)}</div>`)}
    ${section('Score tiles: low', `<div class="imdbc-scores">${M.scoreStrip(weak)}</div>`)}
    ${section('Cast', `<div class="imdbc-cast">${cast.map((c) => I(M.personCard(c, { showEpisodes: false }))).join('')}</div>`, '158')}
    ${section('Known for', `<div class="imdbc-knownfor">${credits.slice(0, 4).map((c) => I(M.knownForCard(c))).join('')}</div>`)}
    ${section('Credits', `<div class="imdbc-credits">${credits.slice(0, 14).map((c) => I(M.creditRow(c))).join('')}</div>`, String(credits.length))}
    ${section('More like this', `<div class="imdbc-cards">${credits.slice(4, 12).map((c) => I(M.titleCard(c))).join('')}</div>`)}
    ${section('User reviews', `<div class="imdbc-reviews">${reviews.reviews.map((r) => I(M.reviewCard(r))).join('')}</div>`, '6,086')}
    ${section('Search results', `<div class="imdbc-results">${searchSample.titles.map((t) => I(M.searchTitleRow(t))).join('')}${searchSample.names.map((p) => I(M.searchNameRow(p))).join('')}</div>`)}
  </div>
</div>
<script>
  const r = document.getElementById('ruler');
  const upd = () => {
    const probe = getComputedStyle(document.querySelector('.imdbc-credit .ti'));
    const body = getComputedStyle(document.getElementById('imdbc-root'));
    r.textContent = innerWidth + 'px viewport  |  body ' + body.fontSize + '  |  list item ' + probe.fontSize;
  };
  addEventListener('resize', upd); upd();
</script>
</body></html>`;

fs.writeFileSync(fileURLToPath(new URL('preview.html', import.meta.url)), page);
console.log('wrote preview.html (' + Math.round(page.length / 1024) + ' KB)');
