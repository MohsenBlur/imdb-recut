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

function run(url, label) {
  const { window, document } = parseHTML(
    '<!doctype html><html><head></head><body><div id="__next"></div></body></html>'
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

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
