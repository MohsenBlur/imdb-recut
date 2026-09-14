// Produces the README screenshots from the REAL script rendering REAL IMDb data.
//
// IMDb's bot wall blocks plain fetch, and a userscript manager cannot be loaded
// into headless Chrome. So: headless Chrome (which the wall does let through)
// dumps the real page DOM, the __NEXT_DATA__ payload is lifted out of it, and a
// local page is assembled that serves that payload at the real IMDb path with
// the userscript attached. The script then renders exactly what it renders in
// the browser, and headless Chrome photographs it.
//
//   node tools/shots.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = path.join(ROOT, 'tools/.shots');
const OUT = path.join(ROOT, 'docs/screenshots');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SCRIPT = fs.readFileSync(path.join(ROOT, 'recut.user.js'), 'utf8');

const TARGETS = [
  { name: 'title', imdbPath: '/title/tt0120737/', height: 1150, label: 'a film' },
  { name: 'person', imdbPath: '/name/nm0000276/', height: 1250, label: 'a person' },
  { name: 'ratings', imdbPath: '/title/tt0120737/ratings/', height: 1100, label: 'the ratings breakdown' },
  { name: 'episodes', imdbPath: '/title/tt0903747/episodes/', height: 1200, label: 'an episode list' },
  { name: 'chart', imdbPath: '/chart/top/', height: 1150, label: 'the Top 250' }
];

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

function chrome(args) {
  return execFileSync(CHROME, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function dumpDom(url) {
  // --headless=new plus a real user agent is what gets past the bot wall;
  // the old headless mode is served a 403.
  const buf = chrome(['--headless=new', '--disable-gpu', '--no-sandbox', `--user-agent=${UA}`,
    '--virtual-time-budget=25000', '--dump-dom', url]);
  return buf.toString('utf8');
}

function extractPayload(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__ in the dumped DOM');
  JSON.parse(m[1]);            // fail loudly here rather than in the browser
  return m[1];
}

// Every network call goes through the local proxy, exactly as GM_xmlhttpRequest
// ignores CORS — otherwise Rotten Tomatoes and Letterboxd would silently fail
// and the screenshot would show "no match" where the real page shows a score.
const SHIM = `
(function () {
  var store = { 'setting:theme': 'dark' };
  window.GM_getValue = function (k, d) { return k in store ? store[k] : d; };
  window.GM_setValue = function (k, v) { store[k] = v; };
  window.GM_deleteValue = function (k) { delete store[k]; };
  window.GM_listValues = function () { return Object.keys(store); };
  window.GM_registerMenuCommand = function () {};
  window.GM_xmlhttpRequest = function (o) {
    fetch('/x?u=' + encodeURIComponent(o.url), { headers: o.headers || {} })
      .then(function (r) { return r.text().then(function (t) {
        o.onload && o.onload({ status: r.status, responseText: t, finalUrl: r.headers.get('x-final-url') || o.url });
      }); })
      .catch(function (e) { o.onerror && o.onerror(e); });
  };
})();`;

for (const t of TARGETS) {
  process.stdout.write(`${t.name}: dumping ${t.imdbPath} ... `);
  const dom = dumpDom('https://www.imdb.com' + t.imdbPath);
  const payload = extractPayload(dom);
  process.stdout.write(`${Math.round(payload.length / 1024)} KB payload ... `);

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>IMDb Clean</title></head><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${payload.replace(/<\/script>/gi, '<\\/script>')}</script>
<script>${SHIM}</script>
<script>${SCRIPT.replace(/<\/script>/gi, '<\\/script>')}</script>
</body></html>`;

  const file = path.join(SHOTS, t.name + '.html');
  fs.writeFileSync(file, page);
  fs.writeFileSync(path.join(SHOTS, t.name + '.path'), t.imdbPath);
  process.stdout.write('assembled ... ');

  const out = path.join(OUT, t.name + '.png');
  // Served at the genuine IMDb path so the script's own routing matches.
  chrome(['--headless=new', '--disable-gpu', '--no-sandbox', `--user-agent=${UA}`,
    '--hide-scrollbars', '--force-color-profile=srgb',
    '--virtual-time-budget=90000',
    `--window-size=1400,${t.height}`,
    `--screenshot=${out.replace(/\//g, '\\')}`,
    'http://127.0.0.1:8787' + t.imdbPath]);

  const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
  console.log(size ? `shot ${Math.round(size / 1024)} KB -> docs/screenshots/${t.name}.png` : 'FAILED');
  if (!size) process.exitCode = 1;
}
