// Executes the ENTIRE userscript in a synthetic DOM. `node --check` only parses;
// this catches what parsing cannot: a temporal-dead-zone error, a typo'd
// identifier, a helper used before it exists - any of which would kill the
// script on every IMDb page while the file still "checks out".
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const PATH = fileURLToPath(new URL('../recut.user.js', import.meta.url));
const SRC = fs.readFileSync(PATH, 'utf8');

let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

function run(url, label, payload) {
  const { window, document } = parseHTML(
    '<!doctype html><html><head></head><body><div id="__next"></div>'
    + (payload ? '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(payload) + '</script>' : '')
    + '</body></html>'
  );

  // linkedom has no location/matchMedia/timers wired the way a page does.
  const u = new URL(url);
  const location = { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin, reload() {} };
  const store = new Map();
  const warnings = [];
  const timers = [];

  const sandbox = {
    document,
    window,
    location,
    history: { pushState() {}, replaceState() {} },
    navigator: { userAgent: 'node' },
    console: { warn: (...a) => warnings.push(a.map(String).join(' ')), log() {}, error: (...a) => warnings.push('ERR ' + a.map(String).join(' ')) },
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimeout() {},
    setInterval: (fn, ms) => { timers.push(ms); return timers.length; },
    clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    DOMParser: window.DOMParser,
    URLSearchParams,
    URL,
    CSS: { supports: () => true },
    GM_xmlhttpRequest: () => {},
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => store.set(k, v),
    GM_deleteValue: (k) => store.delete(k),
    GM_listValues: () => [...store.keys()],
    GM_registerMenuCommand: () => {}
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  sandbox.matchMedia = window.matchMedia;
  // linkedom has no scroll methods, and render() calls scrollTo on every
  // route - without this the render always failed and no test could look at
  // what the script actually drew.
  window.scrollTo = () => {};
  sandbox.scrollTo = window.scrollTo;

  const names = Object.keys(sandbox);
  let threw = null;
  try {
    new Function(...names, SRC)(...names.map((k) => sandbox[k]));
  } catch (e) {
    threw = e;
  }

  check(`${label} loads without throwing`, !threw, threw ? threw.constructor.name + ': ' + threw.message : '');
  const hard = warnings.filter((w) => w.startsWith('ERR '));
  check(`${label} logs no errors`, hard.length === 0, hard.slice(0, 2).join(' | '));
  return { document, store, warnings, threw };
}

console.log('[load] the script must survive being executed on every page type');
const pages = [
  ['https://www.imdb.com/', 'homepage (no takeover)'],
  ['https://www.imdb.com/title/tt0120737/', 'title page'],
  ['https://www.imdb.com/name/nm0000704/', 'person page'],
  ['https://www.imdb.com/title/tt0120737/ratings/', 'ratings sub-page'],
  ['https://www.imdb.com/title/tt0903747/episodes/?season=2', 'episodes sub-page'],
  ['https://www.imdb.com/title/tt0120737/fullcredits/', 'full credits sub-page'],
  ['https://www.imdb.com/title/tt0120737/reviews/', 'reviews sub-page'],
  ['https://www.imdb.com/find/?q=granite+flats', 'find results'],
  ['https://www.imdb.com/chart/top/', 'chart'],
  ['https://www.imdb.com/chart/boxoffice/', 'box office chart'],
  ['https://www.imdb.com/list/ls055386972/', 'list'],
  ['https://www.imdb.com/search/title/?genres=sci-fi', 'advanced search'],
  ['https://www.imdb.com/some/unknown/path', 'an unrecognised path']
];
for (const [url, label] of pages) run(url, label);

console.log('\n[takeover] only the pages it handles may be hidden');
{
  const a = run('https://www.imdb.com/title/tt0120737/', 'title');
  check('title page takes over', a.document.documentElement.className.includes('imdbc-on'));
  const b = run('https://www.imdb.com/preferences/general', 'settings page');
  check('an unhandled page is left alone', !b.document.documentElement.className.includes('imdbc-on'),
    b.document.documentElement.className || '(no class)');
}

console.log('\n[cache] the store stays bounded and versioned');
{
  const { store } = run('https://www.imdb.com/', 'homepage');
  const keys = [...store.keys()];
  check('nothing is written to the store just by loading', keys.length === 0, keys.slice(0, 3).join(', '));
}

console.log('\n[links] every page the homepage offers must be one we render');
{
  // A link we print is a promise we keep. /chart/boxoffice/ was linked from the
  // first homepage and fell through to the "could not read this page" card,
  // because it is the one chart IMDb ships under its own payload key.
  const LINES = SRC.split(/\r?\n/);
  const sliceConst = (name) => {
    const i = LINES.findIndex((l) => new RegExp('^  const ' + name + '\\b').test(l));
    if (i < 0) throw new Error('not found: ' + name);
    for (let j = i; j < Math.min(i + 60, LINES.length); j++) {
      if (LINES[j].trimEnd() === '  ];') return LINES.slice(i, j + 1).join('\n');
    }
    throw new Error('no end for ' + name);
  };
  const { HOME_LINKS, HOME_ROWS } = new Function(
    sliceConst('HOME_LINKS') + '\n' + sliceConst('HOME_ROWS') + '\nreturn { HOME_LINKS, HOME_ROWS };')();

  const paths = [...HOME_LINKS.map((l) => l.path), ...HOME_ROWS.map((r) => r.more).filter(Boolean)];
  check('the homepage offers links at all', paths.length >= 6, paths.length + ' links');
  for (const full of paths) {
    const { document } = run('https://www.imdb.com' + full, 'link ' + full);
    check(full + ' is a route we take over',
      document.documentElement.className.includes('imdbc-on'),
      document.documentElement.className || '(left as IMDb)');
  }
}

console.log('\n[boxoffice] the takings chart has its own payload shape');
{
  // Trimmed from a real /chart/boxoffice/ payload. Recognising the ROUTE was
  // never the problem - the payload guard only knew about `chartTitles`, so the
  // page took over and then refused to draw.
  const money = (amount) => ({ total: { amount, currency: 'USD' } });
  const payload = { props: { pageProps: { pageData: { topGrossingReleases: {
    timeWindowStartDate: '2026-09-11',
    timeWindowEndDate: '2026-09-13',
    edges: [{ node: {
      gross: money(30000000),
      release: { weeksRunning: 1, titles: [{
        id: 'tt32588798',
        titleText: { text: 'Practical Magic 2' },
        titleType: { id: 'movie' },
        ratingsSummary: { aggregateRating: 6.4, voteCount: 4370 },
        lifetimeGross: money(30000000)
      }] }
    } }, { node: {
      gross: money(8400000),
      release: { weeksRunning: 7, titles: [{
        id: 'tt22084616',
        titleText: { text: 'Spider-Man: Brand New Day' },
        titleType: { id: 'movie' },
        ratingsSummary: { aggregateRating: 8.0, voteCount: 299000 },
        lifetimeGross: money(935000000)
      }] }
    } }]
  } } } } };

  const { document } = run('https://www.imdb.com/chart/boxoffice/', 'box office', payload);
  // The render is async even when the payload is already in the page, so let
  // the microtask queue drain before reading what it drew.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  const text = (document.getElementById('imdbc-root') || {}).textContent || '';
  check('it renders rows, not the failure card', !/could not read/i.test(text));
  check('both releases are listed', text.includes('Practical Magic 2') && text.includes('Spider-Man: Brand New Day'));
  check('the weekend take is shown', text.includes('$30M this weekend'));
  check('a running total is shown when it differs', text.includes('$935M total'));
  check('the first week is not called "week 1"', text.includes('first week') && !/week 1\b/.test(text));
  check('the date window is spelled out', text.includes('11 Sep 2026'));
}

console.log('\n[overlays] the takeover must not hide its own overlays');
{
  // The takeover hides every direct child of <body> that is not its root. The
  // lightbox was appended to <body>, so it was created display:none - present
  // in the DOM but invisible. Both halves of the fix are asserted, because
  // checking only that the element EXISTS is exactly what missed it.
  const hideRule = SRC.split(String.fromCharCode(10)).find((l) => l.startsWith('html.imdbc-on body >')) || '';
  check('the body-hiding rule is present', !!hideRule, hideRule.slice(0, 60));
  check('it exempts the lightbox', hideRule.includes(':not(#imdbc-lightbox)'), hideRule.slice(0, 120));
  const appendLine = (SRC.split(String.fromCharCode(10)).find((l) => l.includes('appendChild(box)')) || '').trim();
  check('the lightbox is appended inside the root, not the body',
    /imdbc-root/.test(appendLine), appendLine.slice(0, 80));
}

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
