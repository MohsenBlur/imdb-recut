// Exercises the search normaliser and row builders sliced out of the real
// source, against a payload shaped exactly as observed on IMDb's /find page.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

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
    for (let j = i + 1; j < LINES.length; j++) {
      if (LINES[j] === '  }') return LINES.slice(i, j + 1).join('\n');
    }
    throw new Error('no end for ' + name);
  }
  // A const may span lines (multi-line arrow, template literal, object). Stop at
  // the first line that ends the statement with everything balanced.
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
  function safeUrl(u) {
    if (!u) return '';
    const s = String(u).trim();
    if (/^https?:\\/\\//i.test(s)) return s;
    if (/^\\/(?!\\/)/.test(s)) return 'https://www.imdb.com' + s;
    return '';
  }
  let pageLocale = '';
  const setLocale = (l) => { pageLocale = l; };
`;

const NAMES = ['num', 'compactNum', 'runtimeText', 'yearText', 'imgSize', 'thumb', 'imdbUrl', 'titleUrl', 'nameUrl', 'initials',
  'RATING_BANDS', 'ratingBand', 'THIN_VOTES', 'ratingClasses',
  'findUrl', 'normaliseSearch', 'searchTitleRow', 'searchNameRow'];
const EXPORTS = ['normaliseSearch', 'searchTitleRow', 'searchNameRow', 'findUrl', 'interpolate', 'thumb', 'imgSize',
  'titleUrl', 'nameUrl', 'setLocale'];
const M = new Function(PRE + NAMES.map(sliceDecl).join('\n\n') + '\nreturn {' + EXPORTS.join(',') + '};')();

let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

// Shape copied from the live payload observed on /find/?q=granite+flats
const payload = {
  findPageMeta: { searchTerm: 'granite flats', includeAdult: false, isExactMatch: false },
  resultsSectionOrder: ['TITLE', 'INTEREST', 'NAME'],
  titleResults: {
    nextCursor: 'eyJ-cursor',
    results: [{
      index: 'tt2624370',
      listItem: {
        titleId: 'tt2624370', titleText: 'Granite Flats', originalTitleText: 'Granite Flats',
        titleType: { id: 'tvSeries', text: 'TV Series', canHaveEpisodes: true },
        releaseYear: 2013, endYear: 2015, certificate: 'TV-G', genres: ['Drama'],
        plot: 'When a mysterious object falls from the sky, three young sleuths investigate.',
        primaryImage: { url: 'https://m.media-amazon.com/images/M/MV5BNTg4._V1_.jpg', width: 900, height: 1391 },
        ratingSummary: { aggregateRating: 7.9, voteCount: 1308 },
        runtime: { seconds: 3000 }
      }
    }, {
      // a film with no year, no rating, no poster and a hostile title
      index: 'tt9999999',
      listItem: { titleId: 'tt9999999', titleText: '<img src=x onerror=alert(1)>', titleType: { id: 'movie', text: 'Movie' }, genres: [] }
    }]
  },
  nameResults: {
    results: [{
      index: 'nm0000704',
      listItem: {
        nameId: 'nm0000704', nameText: 'Elijah Wood',
        professions: ['Actor', 'Producer', 'Additional Crew'],
        primaryImage: { url: 'https://m.media-amazon.com/images/M/MV5BMTM0._V1_.jpg' },
        knownFor: { titleId: 'tt0120737', titleText: 'The Lord of the Rings: The Fellowship of the Ring', yearRange: { year: 2001, endYear: null } }
      }
    }]
  },
  interestResults: { results: [] }, companyResults: { results: [] }, keywordResults: { results: [] }
};

console.log('[normaliseSearch]');
const s = M.normaliseSearch(payload, { query: 'granite flats', section: '' });
check('query carried through', s.query === 'granite flats', s.query);
check('titles parsed', s.titles.length === 2, `${s.titles.length}`);
check('year range from flat releaseYear/endYear', s.titles[0].year === '2013\u20132015', s.titles[0].year);
check('rating parsed', s.titles[0].rating === 7.9);
check('runtime from {seconds}', s.titles[0].runtime === '50m', s.titles[0].runtime);
check('type text kept', s.titles[0].typeText === 'TV Series');
check('missing year does not become "undefined"', s.titles[1].year === '', JSON.stringify(s.titles[1].year));
check('more-titles flag from nextCursor', s.moreTitles === true);
check('names parsed', s.names.length === 1);
check('knownFor is a single object, not an array', !!(s.names[0].knownFor && s.names[0].knownFor.title), JSON.stringify(s.names[0].knownFor));
check('knownFor year from yearRange', s.names[0].knownFor.year === '2001', s.names[0].knownFor.year);
check('professions parsed', s.names[0].professions.length === 3);

console.log('\n[row builders / escaping]');
const rowA = M.interpolate(M.searchTitleRow(s.titles[0]));
const rowB = M.interpolate(M.searchTitleRow(s.titles[1]));
const rowC = M.interpolate(M.searchNameRow(s.names[0]));
check('title row links to the title page', rowA.includes('href="https://www.imdb.com/title/tt2624370/"'));
check('poster is requested as a thumbnail, not the original', rowA.includes('_QL75_UX96_'), (rowA.match(/_V1_[^"]*/) || [''])[0]);
check('rating rendered', rowA.includes('7.9'));
check('hostile title is escaped, not injected', !rowB.includes('<img src=x') && rowB.includes('&lt;img src=x'), 'no raw tag');
{
  // Parse it rather than grep it: the escaped text legitimately contains the
  // characters 'onerror=', what matters is that no ELEMENT carries the attribute.
  const doc = new DOMParser().parseFromString('<div>' + rowB + '</div>', 'text/html');
  const injected = [...doc.querySelectorAll('*')].filter((el) => el.hasAttribute && el.hasAttribute('onerror'));
  const imgs = doc.querySelectorAll('img');
  check('no element carries an injected handler', injected.length === 0, injected.length + ' found');
  check('the hostile string produced no <img> element', imgs.length === 0, imgs.length + ' imgs');
  check('it survives as visible text instead', (doc.querySelector('.ti').textContent || '').includes('<img src=x onerror=alert(1)>'));
}
check('row with no poster still renders', rowB.includes('imdbc-result') && rowB.includes('tt9999999'));
check('name row links to the person', rowC.includes('href="https://www.imdb.com/name/nm0000704/"'));
check('known-for shown', rowC.includes('Known for The Lord of the Rings'));

console.log('\n[thumb] must never ask Amazon to crop - that pads with white');
{
  const U = 'https://m.media-amazon.com/images/M/MV5BABC._V1_.jpg';
  const wide = M.thumb(U, 180, 270, { width: 1000, height: 1178 });   // 0.85, wider than the 0.667 box
  const tall = M.thumb(U, 180, 270, { width: 1000, height: 2000 });   // 0.50, taller than the 0.667 box
  const exact = M.thumb(U, 180, 270, { width: 2000, height: 3000 });  // exactly 2:3
  const unknown = M.thumb(U, 180, 270);
  check('no crop directive is ever emitted', ![wide, tall, unknown, exact].some((u) => u.includes('_CR')), wide);
  check('a wide source scales to height, so cover crops the sides', wide.includes('_UY270_'), wide.split('._V1_')[1]);
  check('a tall source scales to width, so cover crops top and bottom', tall.includes('_UX180_'), tall.split('._V1_')[1]);
  check('an exactly 2:3 source needs no upscaling either way', exact.includes('_UX180_') || exact.includes('_UY270_'), exact.split('._V1_')[1]);
  check('unknown size defaults to height', unknown.includes('_UY270_'), unknown.split('._V1_')[1]);
  check('non-Amazon urls pass through untouched', M.thumb('https://example.com/a.jpg', 10, 20) === 'https://example.com/a.jpg');
  check('javascript: urls are refused', M.thumb('javascript:alert(1)', 10, 20) === '');
  check('imgSize ignores partial dimensions', M.imgSize({ width: 5 }) === null && M.imgSize(null) === null);
  check('imgSize passes real dimensions', JSON.stringify(M.imgSize({ width: 4, height: 6, url: 'x' })) === '{"width":4,"height":6}');
}

console.log('\n[findUrl]');
check('encodes the query', M.findUrl('lord of the rings', '') === 'https://www.imdb.com/find/?q=lord%20of%20the%20rings', M.findUrl('lord of the rings', ''));
check('adds the section', M.findUrl('x', 'tt').endsWith('&s=tt'));
check('ampersand in the query is encoded', M.findUrl('fast & furious', '').includes('%26'), M.findUrl('fast & furious', ''));

console.log('\n[locale] IMDb serves /de/, /es/ ... and links must stay in that language');
{
  M.setLocale('');
  check('no prefix by default', M.titleUrl('tt1') === 'https://www.imdb.com/title/tt1/', M.titleUrl('tt1'));
  M.setLocale('/de');
  check('title links keep the prefix', M.titleUrl('tt1') === 'https://www.imdb.com/de/title/tt1/', M.titleUrl('tt1'));
  check('name links keep the prefix', M.nameUrl('nm1') === 'https://www.imdb.com/de/name/nm1/', M.nameUrl('nm1'));
  check('search keeps the prefix', M.findUrl('x', '') === 'https://www.imdb.com/de/find/?q=x', M.findUrl('x', ''));
  check('and the section still appends', M.findUrl('x', 'tt').endsWith('&s=tt'), M.findUrl('x', 'tt'));
  M.setLocale('');
}

console.log('\n[empty payload]');
const empty = M.normaliseSearch({}, { query: 'zzz', section: 'tt' });
check('no payload does not throw and yields nothing', empty.titles.length === 0 && empty.names.length === 0 && empty.query === 'zzz');

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
