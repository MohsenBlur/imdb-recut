// ==UserScript==
// @name         Recut for IMDb
// @namespace    https://github.com/MohsenBlur/imdb-recut
// @version      2.3.0
// @description  Replaces IMDb pages with a dense, quiet layout: cast, user reviews (with Rotten Tomatoes critic + audience scores), season/episode counts and recommendations for titles; known-for and a full filmography with the characters played for people. Everything else is gone.
// @author       MohsenBlur
// @match        https://www.imdb.com/*
// @match        https://imdb.com/*
// @match        https://m.imdb.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @connect      imdb.com
// @connect      media-imdb.com
// @connect      api.graphql.imdb.com
// @connect      query.wikidata.org
// @connect      www.rottentomatoes.com
// @connect      rottentomatoes.com
// @connect      letterboxd.com
// @connect      trakt.tv
// @noframes
// ==/UserScript==

/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_registerMenuCommand, GM */

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  // 0. Route detection — decide at document-start whether we take over at all
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * We only take over the *root* title and name pages. Sub-pages
   * (/fullcredits, /reviews, /episodes, /bio ...) are left completely alone so
   * there is always an untouched IMDb one click away.
   */
  function routeFor(pathname, search) {
    let m = /^\/title\/(tt\d+)\/?$/.exec(pathname);
    if (m) return { kind: 'title', id: m[1] };
    m = /^\/name\/(nm\d+)\/?$/.exec(pathname);
    if (m) return { kind: 'name', id: m[1] };
    // Title sub-pages. These are the ones this script's own links point at, so
    // leaving them raw is what made the whole thing feel half-applied.
    m = /^\/title\/(tt\d+)\/(ratings|fullcredits|episodes|reviews)\/?$/.exec(pathname);
    if (m) {
      const kind = { ratings: 'titleRatings', fullcredits: 'titleCredits', episodes: 'titleEpisodes', reviews: 'titleReviews' }[m[2]];
      let season = '';
      if (kind === 'titleEpisodes') {
        try { season = new URLSearchParams(search || '').get('season') || ''; } catch (_) { season = ''; }
      }
      return { kind, id: m[1], season, sub: m[2], routeId: m[1] + ':' + m[2] + ':' + season };
    }
    m = /^\/chart\/([a-z0-9-]+)\/?$/.exec(pathname);
    if (m && CHARTS[m[1]]) return { kind: 'chart', id: m[1], routeId: 'chart:' + m[1] };
    m = /^\/list\/(ls\d+)\/?$/.exec(pathname);
    if (m) return { kind: 'list', id: m[1], routeId: 'list:' + m[1] };
    if (/^\/search\/title\/?$/.test(pathname)) {
      // The query IS the page here, so it has to key the route.
      return { kind: 'titleSearch', id: 'search', query: search || '', routeId: 'search:' + (search || '') };
    }
    if (/^\/find\/?$/.test(pathname)) {
      let params;
      try { params = new URLSearchParams(search || ''); } catch (_) { return null; }
      const query = (params.get('q') || '').trim();
      const section = params.get('s') || '';
      // The id has to fold in the query, or navigating between two searches
      // looks like "same route" and never re-renders.
      if (query) return { kind: 'search', id: 'find:' + section + ':' + query, query, section };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Settings
  // ══════════════════════════════════════════════════════════════════════════

  const SETTING_DEFS = {
    theme: { def: 'auto', label: 'Theme', options: ['auto', 'dark', 'light'] },
    rottenTomatoes: { def: true, label: 'Look up Rotten Tomatoes scores' },
    fullCast: { def: true, label: 'Load the complete cast list' },
    fullCredits: { def: true, label: 'Load the complete filmography' },
    hideSelfCredits: { def: true, label: 'Hide "Self" and archive-footage credits by default' },
    declineCookies: { def: true, label: 'Hide and decline the cookie banner' },
    trailers: { def: true, label: 'Show trailers and videos' },
    photos: { def: true, label: 'Show photos' },
    reviewCount: { def: 10, label: 'User reviews per page' }
  };

  const settings = {};
  function loadSettings() {
    for (const [key, def] of Object.entries(SETTING_DEFS)) {
      let v;
      try { v = GM_getValue('setting:' + key, def.def); } catch (_) { v = def.def; }
      settings[key] = v === undefined || v === null ? def.def : v;
    }
  }
  function saveSetting(key, value) {
    settings[key] = value;
    try { GM_setValue('setting:' + key, value); } catch (_) { /* storage unavailable */ }
  }
  loadSettings();

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Tiny HTML builder — every interpolation is escaped unless wrapped in raw()
  // ══════════════════════════════════════════════════════════════════════════

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

  /** Only http(s) survives; everything else (javascript:, data:) becomes empty. */
  function safeUrl(u) {
    if (!u) return '';
    const s = String(u).trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\/(?!\/)/.test(s)) return 'https://www.imdb.com' + s;
    return '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Formatting helpers
  // ══════════════════════════════════════════════════════════════════════════

  // ── Rating bands ──────────────────────────────────────────────────────────
  // One colour scale for every rating on every page, so a filmography can be
  // skimmed for the good entries without reading a single number. Scores are
  // normalised to a percentage first, which is why 60 doubles as both the
  // amber/red boundary here and Rotten Tomatoes' own fresh/rotten line.
  const RATING_BANDS = [[80, 'top'], [70, 'high'], [60, 'mid'], [-Infinity, 'low']];

  function ratingBand(value, outOf) {
    if (typeof value !== 'number' || !isFinite(value)) return '';
    const pct = (value / (outOf || 10)) * 100;
    for (const [min, key] of RATING_BANDS) if (pct >= min) return 'rb-' + key;
    return 'rb-low';
  }

  /**
   * A high score from a handful of voters is noise, and noise is exactly what
   * ruins skimming — an obscure short at 9.8/10 from 14 votes would otherwise
   * shout louder than a classic. Dim those instead of dropping them.
   */
  const THIN_VOTES = 1000;
  function ratingClasses(value, outOf, votes) {
    const band = ratingBand(value, outOf);
    if (!band) return '';
    return band + (typeof votes === 'number' && votes > 0 && votes < THIN_VOTES ? ' rb-thin' : '');
  }

  const num = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '');

  function compactNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function runtimeText(seconds) {
    if (!seconds || seconds < 60) return '';
    const mins = Math.round(seconds / 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  }

  function yearText(releaseYear) {
    if (!releaseYear || !releaseYear.year) return '';
    const { year, endYear } = releaseYear;
    if (endYear && endYear !== year) return `${year}–${endYear}`;
    return String(year);
  }

  /** IMDb's date fields are {year, month, day} objects, not strings. */
  function imdbDateText(d) {
    if (!d || !d.year) return '';
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    if (d.month && d.day) return `${MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
    if (d.month) return `${MONTHS[d.month - 1]} ${d.year}`;
    return String(d.year);
  }

  function ageFrom(birth, death) {
    if (!birth || !birth.year) return null;
    const end = death && death.year ? death : nowParts();
    let age = end.year - birth.year;
    if (birth.month && end.month) {
      if (end.month < birth.month || (end.month === birth.month && birth.day && end.day && end.day < birth.day)) age--;
    }
    return age >= 0 && age < 130 ? age : null;
  }

  function nowParts() {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }

  function reviewDateText(iso) {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return String(iso);
    return imdbDateText({ year: +m[1], month: +m[2], day: +m[3] });
  }

  /**
   * Rewrite an IMDb media URL to ask Amazon for a thumbnail instead of the
   * multi-megabyte original. Verified against three real URL shapes, including
   * ones that already carry a _CR.._ segment.
   */
  /**
   * Amazon's `_CR_` directive PADS rather than crops when the scaled image is
   * smaller than the crop box. Verified: a 1000x1178 headshot requested as
   * UX180_CR0,0,180,270 comes back 180x270 with white bars baked in — which is
   * exactly the light edge that showed against the dark cards. So never crop
   * server-side: scale along whichever axis makes the image cover the box, and
   * let CSS `object-fit: cover` do the cropping.
   */
  function thumb(url, w, h, src) {
    const u = safeUrl(url);
    if (!u) return '';
    if (!/m\.media-amazon\.com|images-amazon\.com/.test(u)) return u;
    let spec;
    if (!h) {
      spec = `._V1_QL75_UX${w}_`;
    } else if (src && src.width > 0 && src.height > 0) {
      spec = (src.width / src.height > w / h) ? `._V1_QL75_UY${h}_` : `._V1_QL75_UX${w}_`;
    } else {
      // Source size unknown. Scaling to height is the safer default for a
      // portrait box: the common case is a headshot wider than 2:3.
      spec = `._V1_QL75_UY${h}_`;
    }
    return u.replace(/\._V1_.*?(\.\w+)$/, spec + '$1');
  }

  /** Pull {width,height} off an IMDb image node, when it carries them. */
  function imgSize(node) {
    if (!node) return null;
    // The sub-pages spell these maxWidth/maxHeight; everywhere else it is
    // width/height. An unrecognised shape must yield null, not a half-size.
    const w = node.width || node.maxWidth;
    const h = node.height || node.maxHeight;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }

  const titleUrl = (id) => `https://www.imdb.com/title/${encodeURIComponent(id)}/`;
  const nameUrl = (id) => `https://www.imdb.com/name/${encodeURIComponent(id)}/`;

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Network — everything external goes through GM_xmlhttpRequest so page CSP
  //    and Rotten Tomatoes' fetch-wrapping bot detection cannot interfere.
  // ══════════════════════════════════════════════════════════════════════════

  const gmRequest = (typeof GM_xmlhttpRequest === 'function')
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function')
      ? GM.xmlHttpRequest.bind(GM)
      : null;

  function netGet(url, { headers = {}, timeout = 20000 } = {}) {
    if (!gmRequest) return Promise.reject(new Error('GM_xmlhttpRequest is unavailable'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      try {
        gmRequest({
          method: 'GET',
          url,
          headers: Object.assign({ Accept: '*/*' }, headers),
          timeout,
          anonymous: false,
          onload: (r) => {
            if (r.status >= 200 && r.status < 400) done(resolve, r.responseText);
            else done(reject, new Error(`HTTP ${r.status} from ${url}`));
          },
          onerror: () => done(reject, new Error(`network error for ${url}`)),
          onabort: () => done(reject, new Error(`aborted: ${url}`)),
          ontimeout: () => done(reject, new Error(`timeout after ${timeout}ms: ${url}`))
        });
      } catch (e) {
        done(reject, e);
      }
    });
  }

  /** Like netGet, but also hands back the URL the request actually ended on. */
  function netGetFull(url, { headers = {}, timeout = 20000 } = {}) {
    if (!gmRequest) return Promise.reject(new Error('GM_xmlhttpRequest is unavailable'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      try {
        gmRequest({
          method: 'GET',
          url,
          headers: Object.assign({ Accept: '*/*' }, headers),
          timeout,
          onload: (r) => {
            if (r.status >= 200 && r.status < 400) done(resolve, { text: r.responseText, finalUrl: r.finalUrl || '', status: r.status });
            else done(reject, new Error(`HTTP ${r.status} from ${url}`));
          },
          onerror: () => done(reject, new Error(`network error for ${url}`)),
          onabort: () => done(reject, new Error(`aborted: ${url}`)),
          ontimeout: () => done(reject, new Error(`timeout after ${timeout}ms: ${url}`))
        });
      } catch (e) {
        done(reject, e);
      }
    });
  }
  // ── Caches ────────────────────────────────────────────────────────────────
  // IMDb GraphQL results live in memory only (they are large and cheap to
  // refetch). Rotten Tomatoes lookups persist, because they are slow and the
  // scores barely move.

  const memCache = new Map();
  function memoize(key, ttlMs, producer) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.t < ttlMs) return hit.p;
    const p = producer();
    memCache.set(key, { t: Date.now(), p });
    p.catch(() => memCache.delete(key));
    return p;
  }

  const DISK_ROOT = 'cache:';
  // Bump when any cached value changes shape; old entries become unreachable.
  const DISK_PREFIX = DISK_ROOT + 'v2:';
  const DISK_INDEX = DISK_PREFIX + 'index';
  const DISK_MAX_ENTRIES = 80;
  const DISK_MAX_BYTES = 2_000_000;

  function diskGet(key) {
    try {
      const rec = GM_getValue(DISK_PREFIX + key, null);
      if (!rec) return null;
      const parsed = typeof rec === 'string' ? JSON.parse(rec) : rec;
      if (!parsed || typeof parsed.t !== 'number') return null;
      if (Date.now() - parsed.t > parsed.ttl) return null;
      return { value: parsed.v };
    } catch (_) { return null; }
  }

  function diskSet(key, value, ttl) {
    try {
      const body = JSON.stringify({ t: Date.now(), ttl, v: value });
      // A whole filmography is a few hundred KB; something far larger is a sign
      // the shape changed, and filling the store would evict everything useful.
      if (body.length > DISK_MAX_BYTES) { warn('not caching oversized entry', key, body.length); return; }
      GM_setValue(DISK_PREFIX + key, body);
      touchIndex(key);
    } catch (e) { warn('cache write failed', key, e); }
  }

  /** Keep the store bounded: oldest entries go first. */
  function touchIndex(key) {
    let index;
    try { index = JSON.parse(GM_getValue(DISK_INDEX, '{}')); } catch (_) { index = {}; }
    if (!index || typeof index !== 'object') index = {};
    index[key] = Date.now();
    const keys = Object.keys(index);
    if (keys.length > DISK_MAX_ENTRIES) {
      keys.sort((a, b) => index[a] - index[b]);
      for (const old of keys.slice(0, keys.length - DISK_MAX_ENTRIES)) {
        try { GM_deleteValue(DISK_PREFIX + old); } catch (_) { /* gone already */ }
        delete index[old];
      }
    }
    try { GM_setValue(DISK_INDEX, JSON.stringify(index)); } catch (_) { /* full */ }
  }

  function diskClear() {
    try {
      // Sweep every schema version, not just the current one.
      for (const k of GM_listValues()) if (k.startsWith(DISK_ROOT)) GM_deleteValue(k);
    } catch (_) { /* unavailable */ }
  }

  /**
   * memoize() but backed by the store as well as memory, so a second visit to a
   * person page does not re-fetch 500+ credits. Only non-empty results are
   * persisted: caching an empty list would hide a transient failure for hours.
   */
  function memoizeDisk(key, ttlMs, producer) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.t < ttlMs) return hit.p;

    const stored = diskGet(key);
    if (stored && stored.value && (!Array.isArray(stored.value) || stored.value.length)) {
      const p = Promise.resolve(stored.value);
      memCache.set(key, { t: Date.now(), p });
      return p;
    }

    const p = producer().then((value) => {
      if (value && (!Array.isArray(value) || value.length)) diskSet(key, value, ttlMs);
      return value;
    });
    memCache.set(key, { t: Date.now(), p });
    p.catch(() => memCache.delete(key));
    return p;
  }

  // ── IMDb GraphQL ──────────────────────────────────────────────────────────
  // Public, unauthenticated, GET-only. Introspection is blocked but field
  // queries work. Every nested connection MUST carry its own `first:`.

  const GQL_ENDPOINT = 'https://api.graphql.imdb.com/';

  // The endpoint gates on TWO things, verified by probing it directly:
  //   - Content-Type: application/json, or it answers 415.
  //   - a client identity header, or it answers 403. A page's own fetch() passes
  //     because the browser attaches Referer automatically; GM_xmlhttpRequest
  //     sends no Referer, so the header has to be explicit. x-imdb-client-name is
  //     used rather than Referer because Referer is a forbidden XHR header that
  //     not every userscript manager will let us set.
  const GQL_HEADERS = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-imdb-client-name': 'imdb-web-next'
  };

  async function gql(query) {
    const compact = query.replace(/\s+/g, ' ').trim();
    const url = GQL_ENDPOINT + '?query=' + encodeURIComponent(compact);
    const text = await netGet(url, { headers: GQL_HEADERS });
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error('IMDb GraphQL returned non-JSON'); }
    if (json.errors && json.errors.length) {
      throw new Error('IMDb GraphQL: ' + json.errors.map((e) => e.message).join(' | '));
    }
    return json.data;
  }

  const gqlStr = (s) => JSON.stringify(String(s));

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Reading the server-rendered payload
  // ══════════════════════════════════════════════════════════════════════════

  function readNextData(doc) {
    const el = (doc || document).getElementById('__NEXT_DATA__');
    if (!el || !el.textContent) return null;
    try { return JSON.parse(el.textContent); } catch (_) { return null; }
  }

  /** True when the page's baked-in payload actually describes the URL we are on. */
  function payloadMatches(nd, route) {
    const pp = nd && nd.props && nd.props.pageProps;
    if (!pp) return false;
    if (route.kind === 'search') {
      return !!(pp.findPageMeta && pp.findPageMeta.searchTerm === route.query);
    }
    if (route.sub) {
      const e = pp.contentData && pp.contentData.entityMetadata;
      return !!(e && e.id === route.id);
    }
    if (route.kind === 'chart') return !!(pp.pageData && pp.pageData.chartTitles);
    if (route.kind === 'list') return !!(pp.mainColumnData && pp.mainColumnData.list);
    if (route.kind === 'titleSearch') return !!(pp.searchResults && pp.searchResults.titleResults);
    const id = route.kind === 'title'
      ? (pp.tconst || (pp.aboveTheFoldData && pp.aboveTheFoldData.id))
      : (pp.nmconst || (pp.aboveTheFold && pp.aboveTheFold.id));
    return id === route.id;
  }

  /**
   * After a client-side route change the inline __NEXT_DATA__ is stale, so we
   * pull the destination page's HTML and read its payload instead.
   */
  async function fetchPageProps(route) {
    const url = route.kind === 'search' ? findUrl(route.query, route.section)
      : route.sub ? titleUrl(route.id) + route.sub + '/' + (route.season ? '?season=' + encodeURIComponent(route.season) : '')
      : route.kind === 'chart' ? 'https://www.imdb.com/chart/' + encodeURIComponent(route.id) + '/'
      : route.kind === 'list' ? 'https://www.imdb.com/list/' + encodeURIComponent(route.id) + '/'
      : route.kind === 'titleSearch' ? 'https://www.imdb.com/search/title/' + (route.query || '')
      : route.kind === 'title' ? titleUrl(route.id) : nameUrl(route.id);
    const text = await netGet(url, { headers: { Accept: 'text/html' } });
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const nd = readNextData(doc);
    if (!nd || !payloadMatches(nd, route)) throw new Error('could not read IMDb page data for ' + route.id);
    return nd.props.pageProps;
  }

  async function getPageProps(route) {
    const inline = readNextData(document);
    if (inline && payloadMatches(inline, route)) return inline.props.pageProps;
    return fetchPageProps(route);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Normalising IMDb's payloads into flat shapes the renderers can use
  // ══════════════════════════════════════════════════════════════════════════

  const edges = (conn) => (conn && Array.isArray(conn.edges) ? conn.edges.map((e) => e && e.node).filter(Boolean) : []);

  function normaliseTitle(pp) {
    const atf = pp.aboveTheFoldData || {};
    const main = pp.mainColumnData || {};
    const rs = atf.ratingsSummary || main.ratingsSummary || {};
    const rsMain = main.ratingsSummary || {};

    const t = {
      id: atf.id || main.id || pp.tconst,
      title: (atf.titleText && atf.titleText.text) || (main.titleText && main.titleText.text) || '',
      originalTitle: (atf.originalTitleText && atf.originalTitleText.text) || '',
      typeText: (atf.titleType && atf.titleType.text) || '',
      typeId: (atf.titleType && atf.titleType.id) || '',
      isSeries: !!(atf.titleType && atf.titleType.isSeries),
      isEpisode: !!(atf.titleType && atf.titleType.isEpisode),
      year: yearText(atf.releaseYear),
      startYear: atf.releaseYear && atf.releaseYear.year,
      runtime: runtimeText(atf.runtime && atf.runtime.seconds),
      certificate: (atf.certificate && atf.certificate.rating) || '',
      genres: ((atf.genres && atf.genres.genres) || []).map((g) => g.text).filter(Boolean),
      plot: (atf.plot && atf.plot.plotText && atf.plot.plotText.plainText) || '',
      poster: (atf.primaryImage && atf.primaryImage.url) || (main.primaryImage && main.primaryImage.url) || '',
      posterSize: imgSize(atf.primaryImage) || imgSize(main.primaryImage),
      rating: rs.aggregateRating,
      votes: rs.voteCount,
      topRank: (rsMain.topRanking && rsMain.topRanking.rank) || (rs.topRanking && rs.topRanking.rank),
      metascore: atf.metacritic && atf.metacritic.metascore && atf.metacritic.metascore.score,
      reviewTotal: (main.reviews && main.reviews.total) || 0,
      productionStage: (main.productionStatus && main.productionStatus.currentProductionStage
        && main.productionStatus.currentProductionStage.text) || '',
      watchlisted: (atf.engagementStatistics && atf.engagementStatistics.watchlistStatistics
        && atf.engagementStatistics.watchlistStatistics.displayableCount
        && atf.engagementStatistics.watchlistStatistics.displayableCount.text) || ''
    };

    // Episode pages point back at their series.
    const series = atf.series || main.series;
    if (series && series.series) {
      t.parentSeries = {
        id: series.series.id,
        title: (series.series.titleText && series.series.titleText.text) || ''
      };
      const den = series.displayableEpisodeNumber;
      if (den) {
        t.episodeNumber = {
          season: den.displayableSeason && den.displayableSeason.season,
          episode: den.episodeNumber && den.episodeNumber.episodeNumber
        };
      }
    }

    // Creators / directors / writers / stars.
    t.principals = (atf.principalCreditsV2 || []).map((group) => ({
      label: (group.grouping && group.grouping.text) || '',
      total: group.totalCredits,
      people: (group.credits || []).map((c) => ({
        id: c.name && c.name.id,
        name: c.name && c.name.nameText && c.name.nameText.text
      })).filter((p) => p.name)
    })).filter((g) => g.people.length);

    // Cast as shipped in the page payload (a partial list).
    const castGroup = Array.isArray(main.castV2) ? main.castV2[0] : null;
    t.castTotal = (castGroup && castGroup.totalCredits) || 0;
    t.cast = ((castGroup && castGroup.credits) || []).map(normaliseNameCreditFromTitlePage).filter(Boolean);

    // Seasons / episodes.
    const ep = main.episodes;
    if (ep) {
      t.episodes = {
        total: (ep.totalEpisodes && ep.totalEpisodes.total) || (ep.episodes && ep.episodes.total) || 0,
        seasons: edges(ep.displayableSeasons).map((n) => n.season)
          .filter((s) => s !== null && s !== undefined && s !== ''),
        seasonCount: (ep.displayableSeasons && ep.displayableSeasons.total)
          || (Array.isArray(ep.seasons) ? ep.seasons.length : 0),
        isOngoing: !!ep.isOngoing,
        unknownSeason: (ep.unknownSeasonEpisodes && ep.unknownSeasonEpisodes.total) || 0
      };
      if (!t.episodes.seasons.length && Array.isArray(ep.seasons)) {
        t.episodes.seasons = ep.seasons.map((s) => String(s.number));
      }
    }

    t.kind = 'title';
    t.trailer = normaliseVideo(edges(atf.primaryVideos)[0]);
    t.videos = edges(main.videoStrip).map(normaliseVideo).filter(Boolean);
    t.videoTotal = (atf.videos && atf.videos.total) || t.videos.length;
    t.images = normaliseImages(main.titleMainImages);
    t.imageTotal = (main.titleMainImages && main.titleMainImages.total) || t.images.length;

    t.moreLikeThis = edges(main.moreLikeThisTitles).map(normaliseTitleCard);

    t.featuredReviews = edges(atf.featuredReviews).map(normaliseReview);

    // A very small details block — the only "extra" that survives the cull.
    t.countries = ((main.countriesDetails && main.countriesDetails.countries) || []).map((c) => c.text).filter(Boolean);
    t.languages = ((main.spokenLanguages && main.spokenLanguages.spokenLanguages) || []).map((l) => l.text).filter(Boolean);

    return t;
  }

  /** Title-page cast shape: characters live behind a connection. */
  function normaliseNameCreditFromTitlePage(credit) {
    if (!credit || !credit.name) return null;
    const role = edges(credit.creditedRoles)[0];
    const characters = role ? edges(role.characters).map((c) => c.name).filter(Boolean) : [];
    const attrs = role && Array.isArray(role.attributes) ? role.attributes.map((a) => a.text).filter(Boolean) : [];
    return {
      id: credit.name.id,
      name: (credit.name.nameText && credit.name.nameText.text) || '',
      photo: (credit.name.primaryImage && credit.name.primaryImage.url) || '',
      photoSize: imgSize(credit.name.primaryImage),
      characters,
      attributes: attrs,
      episodeCount: credit.episodeCredits && credit.episodeCredits.total,
      episodeYears: credit.episodeCredits && yearText(credit.episodeCredits.yearRange)
    };
  }

  /** GraphQL title.credits shape: characters and attributes are plain arrays. */
  function normaliseCastFromGraphql(node) {
    if (!node || !node.name) return null;
    return {
      id: node.name.id,
      name: (node.name.nameText && node.name.nameText.text) || '',
      photo: (node.name.primaryImage && node.name.primaryImage.url) || '',
      photoSize: imgSize(node.name.primaryImage),
      characters: (node.characters || []).map((c) => c && c.name).filter(Boolean),
      attributes: (node.attributes || []).map((a) => a && a.text).filter(Boolean),
      episodeCount: node.episodeCredits && node.episodeCredits.total,
      episodeYears: node.episodeCredits && yearText(node.episodeCredits.yearRange)
    };
  }

  function normaliseTitleCard(node) {
    if (!node) return null;
    const genres = ((node.titleGenres && node.titleGenres.genres) || [])
      .map((g) => g && g.genre && g.genre.text).filter(Boolean);
    return {
      id: node.id,
      title: (node.titleText && node.titleText.text) || '',
      plot: (node.plot && node.plot.plotText && node.plot.plotText.plainText) || '',
      year: yearText(node.releaseYear),
      startYear: node.releaseYear && node.releaseYear.year,
      poster: (node.primaryImage && node.primaryImage.url) || '',
      posterSize: imgSize(node.primaryImage),
      rating: node.ratingsSummary && node.ratingsSummary.aggregateRating,
      votes: node.ratingsSummary && node.ratingsSummary.voteCount,
      typeText: (node.titleType && node.titleType.text) || '',
      typeId: (node.titleType && node.titleType.id) || '',
      canHaveEpisodes: !!(node.titleType && node.titleType.canHaveEpisodes),
      runtime: runtimeText(node.runtime && node.runtime.seconds),
      certificate: (node.certificate && node.certificate.rating) || '',
      genres
    };
  }

  function normaliseReview(node) {
    if (!node) return null;
    return {
      id: node.id,
      author: (node.author && node.author.nickName) || 'Anonymous',
      authorId: node.author && node.author.userId,
      summary: (node.summary && node.summary.originalText) || '',
      text: (node.text && node.text.originalText && node.text.originalText.plainText) || '',
      rating: node.authorRating,
      date: node.submissionDate,
      up: (node.helpfulness && node.helpfulness.upVotes) || 0,
      down: (node.helpfulness && node.helpfulness.downVotes) || 0,
      spoiler: !!node.spoiler
    };
  }

  function normalisePerson(pp) {
    const atf = pp.aboveTheFold || {};
    const main = pp.mainColumnData || {};

    const p = {
      id: atf.id || main.id || pp.nmconst,
      name: (atf.nameText && atf.nameText.text) || (main.nameText && main.nameText.text) || '',
      photo: (atf.primaryImage && atf.primaryImage.url) || (main.primaryImage && main.primaryImage.url) || '',
      photoSize: imgSize(atf.primaryImage) || imgSize(main.primaryImage),
      bio: (atf.bio && atf.bio.text && atf.bio.text.plainText) || '',
      professions: ((atf.primaryProfessions || atf.professions || []))
        .map((pr) => (pr && pr.category && pr.category.text) || (pr && pr.profession && pr.profession.text) || (pr && pr.text))
        .filter(Boolean),
      birthDate: (atf.birthDate && atf.birthDate.dateComponents) || atf.birthDate,
      deathDate: (atf.deathDate && atf.deathDate.dateComponents) || atf.deathDate,
      birthPlace: (main.birthLocation && main.birthLocation.text) || '',
      deathPlace: (main.deathLocation && main.deathLocation.text) || '',
      height: (main.height && main.height.displayableProperty && main.height.displayableProperty.value
        && main.height.displayableProperty.value.plainText) || '',
      creditTotal: (main.creditSummary && main.creditSummary.totalCredits && main.creditSummary.totalCredits.total) || 0
    };

    p.kind = 'name';
    p.trailer = normaliseVideo(edges(atf.primaryVideos)[0]);
    p.videos = edges(main.videos).map(normaliseVideo).filter(Boolean);
    p.videoTotal = (main.videos && main.videos.total) || p.videos.length;
    p.images = normaliseImages(main.images);
    p.imageTotal = (main.images && main.images.total) || p.images.length;

    p.knownFor = ((main.knownForFeatureV2 && main.knownForFeatureV2.credits) || [])
      .map(normalisePersonCredit).filter(Boolean);

    if (!p.knownFor.length) {
      p.knownFor = ((atf.knownForV2 && atf.knownForV2.credits) || []).map(normalisePersonCredit).filter(Boolean);
    }

    // Credits as shipped in the page payload: grouped, capped at 15 per group.
    p.credits = [];
    for (const bucket of ['released', 'unreleased']) {
      for (const group of edges(main[bucket])) {
        const label = (group.grouping && group.grouping.text) || 'Other';
        for (const node of edges(group.credits)) {
          const c = normalisePersonCredit(node);
          if (!c) continue;
          c.category = c.category || label;
          if (!c.categories.includes(label)) c.categories.push(label);
          p.credits.push(c);
        }
      }
    }
    p.credits = dedupeCredits(p.credits);

    p.groupTotals = {};
    for (const bucket of ['released', 'unreleased']) {
      for (const group of edges(main[bucket])) {
        const label = (group.grouping && group.grouping.text) || 'Other';
        p.groupTotals[label] = (p.groupTotals[label] || 0) + ((group.credits && group.credits.total) || 0);
      }
    }

    return p;
  }

  /** Name-page / creditsV2 credit shape. */
  function normalisePersonCredit(node) {
    if (!node || !node.title) return null;
    const card = normaliseTitleCard(node.title);
    if (!card || !card.id) return null;
    const roles = edges(node.creditedRoles);
    // Prefer the acting role when there is one: the character played is the
    // thing this page exists to show.
    const role = roles.find((r) => r && r.category && (r.category.traits || []).includes('CAST_TRAIT')) || roles[0];
    const categories = [...new Set(roles.map((r) => r && r.category && r.category.text).filter(Boolean))];
    const characters = role ? edges(role.characters).map((c) => c.name).filter(Boolean) : [];
    const attributes = role && Array.isArray(role.attributes) ? role.attributes.map((a) => a.text).filter(Boolean) : [];
    // The page payload hangs episodeCredits off the credit node; the creditsV2
    // query returns it under the role. Both shapes reach this function.
    const epc = node.episodeCredits || (role && role.episodeCredits);
    const seasons = epc ? edges(epc.displayableSeasons).map((s) => s.season).filter(Boolean) : [];
    return Object.assign(card, {
      creditKey: card.id,
      category: (role && role.category && role.category.text) || '',
      categories,
      traits: (role && role.category && role.category.traits) || [],
      roleText: (role && role.text) || '',
      characters,
      attributes,
      episodeCount: epc && epc.total,
      episodeYears: epc && yearText(epc.yearRange),
      seasons,
      seasonTotal: epc && epc.displayableSeasons && epc.displayableSeasons.total,
      seriesTitle: (node.title.series && node.title.series.series
        && node.title.series.series.titleText && node.title.series.series.titleText.text) || ''
    });
  }

  /** One row per title. Duplicates contribute their category labels and go away. */
  function dedupeCredits(list) {
    const byKey = new Map();
    for (const c of list) {
      const key = c.creditKey || c.id;
      const kept = byKey.get(key);
      if (!kept) { byKey.set(key, c); continue; }
      for (const cat of creditCategories(c)) {
        if (!kept.categories.includes(cat)) kept.categories.push(cat);
      }
      // A later row may know the character when the kept one does not.
      if (!kept.characters.length && c.characters.length) {
        kept.characters = c.characters;
        kept.roleText = c.roleText;
      }
      if (!kept.episodeCount && c.episodeCount) {
        kept.episodeCount = c.episodeCount;
        kept.episodeYears = c.episodeYears;
        kept.seasons = c.seasons;
      }
    }
    return [...byKey.values()];
  }

  function creditCategories(c) {
    const list = (c.categories && c.categories.length) ? c.categories : (c.category ? [c.category] : []);
    return list.length ? list : ['Other'];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. GraphQL fetchers for the parts IMDb does not ship in the page
  // ══════════════════════════════════════════════════════════════════════════

  const CAST_FIELDS = `
    name { id nameText { text } primaryImage { url width height } }
    ... on Cast {
      characters { name }
      attributes { text }
      episodeCredits(first: 1) { total yearRange { year endYear } }
    }`;

  async function fetchFullCast(titleId, cap = 400) {
    const out = [];
    let after = null;
    while (out.length < cap) {
      const pageSize = Math.min(250, cap - out.length);
      const afterArg = after ? `, after: ${gqlStr(after)}` : '';
      const data = await gql(`{
        title(id: ${gqlStr(titleId)}) {
          credits(first: ${pageSize}, filter: { categories: ["cast"] }${afterArg}) {
            total
            pageInfo { hasNextPage endCursor }
            edges { node { ${CAST_FIELDS} } }
          }
        }
      }`);
      const conn = data && data.title && data.title.credits;
      if (!conn) break;
      for (const node of edges(conn)) {
        const c = normaliseCastFromGraphql(node);
        if (c) out.push(c);
      }
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  const REVIEW_SORTS = {
    top: { by: 'HELPFULNESS_SCORE', label: 'Most helpful' },
    votes: { by: 'TOTAL_VOTES', label: 'Most voted' },
    newest: { by: 'SUBMISSION_DATE', label: 'Newest' },
    rating: { by: 'USER_RATING', label: 'Highest rated' }
  };

  async function fetchReviews(titleId, sortKey, first, after) {
    const sort = REVIEW_SORTS[sortKey] || REVIEW_SORTS.top;
    const afterArg = after ? `, after: ${gqlStr(after)}` : '';
    const data = await gql(`{
      title(id: ${gqlStr(titleId)}) {
        reviews(first: ${Math.max(1, Math.min(50, first))}, sort: { by: ${sort.by}, order: DESC }${afterArg}) {
          total
          pageInfo { hasNextPage endCursor }
          edges { node {
            id
            author { nickName userId }
            summary { originalText }
            text { originalText { plainText } }
            authorRating
            submissionDate
            helpfulness { upVotes downVotes }
            spoiler
          } }
        }
      }
    }`);
    const conn = (data && data.title && data.title.reviews) || {};
    return {
      total: conn.total || 0,
      hasMore: !!(conn.pageInfo && conn.pageInfo.hasNextPage),
      cursor: conn.pageInfo && conn.pageInfo.endCursor,
      reviews: edges(conn).map(normaliseReview).filter(Boolean)
    };
  }

  /** One aliased round trip for every season's episode count. */
  async function fetchSeasonCounts(titleId, seasons) {
    const list = seasons.slice(0, 60);
    if (!list.length) return {};
    const aliases = list.map((s, i) => `s${i}: episodes(first: 0, filter: { includeSeasons: [${gqlStr(s)}] }) { total }`);
    const data = await gql(`{ title(id: ${gqlStr(titleId)}) { episodes { ${aliases.join(' ')} } } }`);
    const ep = (data && data.title && data.title.episodes) || {};
    const out = {};
    list.forEach((s, i) => {
      const v = ep['s' + i];
      if (v && typeof v.total === 'number') out[s] = v.total;
    });
    return out;
  }

  const PERSON_CREDIT_FIELDS = `
    title {
      id
      titleText { text }
      titleType { id text canHaveEpisodes }
      releaseYear { year endYear }
      primaryImage { url width height }
      ratingsSummary { aggregateRating voteCount }
      runtime { seconds }
      certificate { rating }
      titleGenres { genres { genre { text } } }
      series { series { id titleText { text } } }
    }
    creditedRoles(first: 12) {
      edges { node {
        text
        attributes { text }
        category { text traits }
        characters(first: 4) { edges { node { name } } }
        episodeCredits(first: 1) {
          total
          yearRange { year endYear }
          displayableSeasons(first: 40) { total edges { node { season } } }
        }
      } }
    }`;

  async function fetchAllCredits(nameId, cap = 1000) {
    const out = [];
    let after = null;
    while (out.length < cap) {
      const pageSize = Math.min(250, cap - out.length);
      const afterArg = after ? `, after: ${gqlStr(after)}` : '';
      const data = await gql(`{
        name(id: ${gqlStr(nameId)}) {
          creditsV2(first: ${pageSize}${afterArg}) {
            total
            pageInfo { hasNextPage endCursor }
            edges { node { ${PERSON_CREDIT_FIELDS} } }
          }
        }
      }`);
      const conn = data && data.name && data.name.creditsV2;
      if (!conn) break;
      for (const node of edges(conn)) {
        const c = normalisePersonCredit(node);
        if (c) out.push(c);
      }
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    return dedupeCredits(out);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. Rotten Tomatoes
  // ══════════════════════════════════════════════════════════════════════════

  const RT_TTL_HIT = 7 * 24 * 3600 * 1000;
  const RT_TTL_MISS = 24 * 3600 * 1000;

  function normaliseTitleForMatch(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/^(the|a|an) /, '')
      .trim();
  }

  // ── Wikidata ──────────────────────────────────────────────────────────────
  // One query serves every external site we link to, so a title costs a single
  // SPARQL request rather than one per destination.
  //   P1258  Rotten Tomatoes id      ("m/slug" or "tv/slug")
  //   P8013  Trakt.tv id             ("movies/slug", "shows/slug", or an
  //                                   episode path "shows/x/seasons/5/episodes/16")
  //   P12492 Trakt.tv movie id       (bare movie slug; needs the movies/ prefix)
  const WD_TTL_HIT = 30 * 24 * 3600 * 1000;
  const WD_TTL_MISS = 3 * 24 * 3600 * 1000;

  const wdInFlight = new Map();

  function wikidataIds(imdbId) {
    if (!/^tt\d+$/.test(imdbId)) return Promise.resolve({ rt: null, trakt: null });
    const cached = diskGet('wd:' + imdbId);
    if (cached && cached.value && typeof cached.value === 'object') return Promise.resolve(cached.value);
    // Rotten Tomatoes and Trakt both want this; one request serves both.
    let p = wdInFlight.get(imdbId);
    if (!p) {
      p = fetchWikidataIds(imdbId).finally(() => wdInFlight.delete(imdbId));
      wdInFlight.set(imdbId, p);
    }
    return p;
  }

  async function fetchWikidataIds(imdbId) {

    const query = `SELECT ?rt ?trakt ?traktMovie WHERE {
        ?item wdt:P345 "${imdbId}" .
        OPTIONAL { ?item wdt:P1258 ?rt . }
        OPTIONAL { ?item wdt:P8013 ?trakt . }
        OPTIONAL { ?item wdt:P12492 ?traktMovie . }
      } LIMIT 5`;
    const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);

    let ids;
    try {
      const json = JSON.parse(await netGet(url, { headers: { Accept: 'application/sparql-results+json' }, timeout: 12000 }));
      const rows = (json && json.results && json.results.bindings) || [];
      const pick = (key, test) => {
        for (const row of rows) {
          const v = row[key] && row[key].value;
          if (typeof v === 'string' && v && (!test || test(v))) return v.replace(/^\/+|\/+$/g, '');
        }
        return null;
      };
      const generic = pick('trakt', (v) => /^(movies|shows)\//.test(v));
      const movieOnly = pick('traktMovie');
      ids = {
        rt: pick('rt', (v) => /^(m|tv)\//.test(v)),
        trakt: generic || (movieOnly ? 'movies/' + movieOnly : null)
      };
    } catch (e) {
      warn('Wikidata lookup failed', e);
      return { rt: null, trakt: null, transient: true };
    }

    diskSet('wd:' + imdbId, ids, (ids.rt || ids.trakt) ? WD_TTL_HIT : WD_TTL_MISS);
    return ids;
  }

  /**
   * Fallback: scrape RT's server-rendered search page. Movie rows and TV rows
   * spell their attributes differently, so read both spellings.
   */
  async function rtSlugFromSearch({ title, year, isSeries, cast }) {
    const url = 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(title);
    const text = await netGet(url, { headers: { Accept: 'text/html' } });
    const doc = new DOMParser().parseFromString(text, 'text/html');

    const wantType = isSeries ? 'tvSeries' : 'movie';
    const blocks = [...doc.querySelectorAll('search-page-result')];
    const ordered = blocks
      .filter((b) => b.getAttribute('type') === wantType)
      .concat(blocks.filter((b) => b.getAttribute('type') !== wantType));

    const target = normaliseTitleForMatch(title);
    const castSet = new Set((cast || []).map((c) => normaliseTitleForMatch(c)).filter(Boolean));
    let best = null;

    for (let bi = 0; bi < ordered.length; bi++) {
      const isPreferredType = ordered[bi].getAttribute('type') === wantType;
      for (const row of ordered[bi].querySelectorAll('search-page-media-row')) {
        const link = row.querySelector('a[data-qa="info-name"]') || row.querySelector('a[slot="title"]');
        const href = link && link.getAttribute('href');
        if (!href) continue;
        const slugMatch = /rottentomatoes\.com\/((?:m|tv)\/[^/?#]+)/.exec(href);
        if (!slugMatch) continue;

        const rowTitle = (link.textContent || '').trim();
        const rowYear = parseInt(
          row.getAttribute('release-year') || row.getAttribute('releaseyear')
          || row.getAttribute('start-year') || row.getAttribute('startyear') || '', 10);
        const rowCast = (row.getAttribute('cast') || '').split(',')
          .map((c) => normaliseTitleForMatch(c)).filter(Boolean);

        const norm = normaliseTitleForMatch(rowTitle);
        let score = 0;
        if (norm === target) score += 100;
        else if (norm.startsWith(target) || target.startsWith(norm)) score += 55;
        else continue; // unrelated title — never guess

        if (isPreferredType) score += 20;
        if (year && rowYear) {
          const delta = Math.abs(rowYear - year);
          if (delta === 0) score += 40;
          else if (delta === 1) score += 20;
          // A same-titled film from a different decade is a remake, not this film.
          // The penalty has to exceed the exact-title bonus or it never decides.
          else if (delta > 3) score -= 60;
        }
        for (const c of rowCast) if (castSet.has(c)) score += 8;

        if (!best || score > best.score) best = { score, slug: slugMatch[1] };
      }
    }
    return best && best.score >= 85 ? best.slug : null;
  }

  async function rtScores(slug) {
    const text = await netGet('https://www.rottentomatoes.com/' + slug, { headers: { Accept: 'text/html' } });
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const node = doc.querySelector('#media-scorecard-json');
    if (!node || !node.textContent) return null;
    let json;
    try { json = JSON.parse(node.textContent); } catch (_) { return null; }

    const pick = (s) => {
      if (!s) return null;
      const score = parseInt(s.score, 10);
      if (!isFinite(score)) return null;
      return {
        score,
        average: s.averageRating || '',
        count: s.reviewCount || s.ratingCount || 0,
        banded: s.bandedRatingCount || '',
        certified: !!s.certified,
        sentiment: s.sentiment || ''
      };
    };

    const critics = pick(json.criticsScore);
    const audience = json.hideAudienceScore ? null : pick(json.audienceScore);
    if (!critics && !audience) return null;
    return { slug, url: 'https://www.rottentomatoes.com/' + slug, critics, audience };
  }

  // Types Rotten Tomatoes simply does not carry. Searching for them returns an
  // unrelated film that happens to share the episode's name.
  const RT_UNSUPPORTED_TYPES = /^(tvEpisode|videoGame|podcastEpisode|podcastSeries|musicVideo)$/;

  async function lookupRottenTomatoes({ imdbId, title, year, isSeries, cast }) {
    const cacheKey = 'rt:' + imdbId;
    const cached = diskGet(cacheKey);
    if (cached) return cached.value;

    let result = null;
    try {
      let slug = null;
      try { slug = (await wikidataIds(imdbId)).rt; } catch (e) { warn('Wikidata lookup failed', e); }
      if (!slug) {
        try { slug = await rtSlugFromSearch({ title, year, isSeries, cast }); } catch (e) { warn('RT search failed', e); }
      }
      if (slug) result = await rtScores(slug);
    } catch (e) {
      warn('Rotten Tomatoes lookup failed', e);
      return null; // transient — do not poison the cache
    }

    diskSet(cacheKey, result, result ? RT_TTL_HIT : RT_TTL_MISS);
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8b. Letterboxd
  // ══════════════════════════════════════════════════════════════════════════

  // Letterboxd is a film site: it has no page for a series, an episode, a game
  // or a podcast. Verified live — /imdb/<id>/ answers 302 to /film/<slug>/ for
  // films (features and shorts alike) and 200 with no redirect for everything
  // else, so an unfiltered button would land on a not-found page.
  const LETTERBOXD_TYPES = /^(movie|tvMovie|short|tvShort|video|tvSpecial)$/;
  const LETTERBOXD_TTL = 7 * 24 * 3600 * 1000;

  const letterboxdRedirect = (imdbId) => 'https://letterboxd.com/imdb/' + encodeURIComponent(imdbId) + '/';

  /** Letterboxd wraps its JSON-LD in CDATA comments, so strip those first. */
  function letterboxdRating(htmlText) {
    if (!htmlText) return null;
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(htmlText);
    if (!m) return null;
    const body = m[1].replace(/^\s*\/\*[\s\S]*?\*\//, '').replace(/\/\*[\s\S]*?\*\/\s*$/, '').trim();
    let j;
    try { j = JSON.parse(body); } catch (_) { return null; }
    const ar = j && j.aggregateRating;
    const rating = ar && Number(ar.ratingValue);
    if (!isFinite(rating)) return null;
    return { rating, count: Number(ar.ratingCount) || 0, best: Number(ar.bestRating) || 5 };
  }

  /**
   * One request serves both the button and the rating tile. Returns null when
   * Letterboxd genuinely has no page, undefined when the lookup itself failed
   * (so a network blip never makes a working button disappear).
   */
  async function letterboxdInfo(imdbId) {
    const cached = diskGet('lbx:' + imdbId);
    if (cached && (cached.value === null || typeof cached.value === 'object')) return cached.value;

    let info = null;
    try {
      const res = await netGetFull(letterboxdRedirect(imdbId), { headers: { Accept: 'text/html' }, timeout: 12000 });
      const finalUrl = res.finalUrl || '';
      let url = /letterboxd\.com\/film\/[^/?#]+/.test(finalUrl) ? finalUrl.split('?')[0] : null;
      if (!url) {
        // Some managers do not expose finalUrl; fall back to the canonical tag.
        const m = /<link[^>]+rel="canonical"[^>]+href="([^"]*letterboxd\.com\/film\/[^"]+)"/i.exec(res.text || '');
        if (m) url = m[1];
      }
      if (url) {
        const r = letterboxdRating(res.text);
        info = { url, rating: r ? r.rating : null, count: r ? r.count : 0, best: r ? r.best : 5 };
      }
    } catch (e) {
      warn('Letterboxd lookup failed', e);
      return undefined;
    }

    diskSet('lbx:' + imdbId, info, LETTERBOXD_TTL);
    return info;
  }

  // ── Trakt ─────────────────────────────────────────────────────────────────
  // Trakt's web app is client-rendered: EVERY path returns 200, including slugs
  // that do not exist, so a link cannot be validated by fetching it the way the
  // Letterboxd one is. The button is therefore shown only when Wikidata yields
  // a real id — no guessed slug, and no search-page fallback, because Cloudflare
  // blocks automated checks and an unverified fallback would be a guess.
  const TRAKT_UNSUPPORTED = /^(videoGame|podcastSeries|podcastEpisode|musicVideo)$/;

  async function traktUrl(imdbId, typeId) {
    if (TRAKT_UNSUPPORTED.test(typeId || '')) return null;
    const ids = await wikidataIds(imdbId);
    if (ids.transient) return undefined;
    if (!ids.trakt) return null;
    // Wikidata stores episode paths like shows/x/seasons/5/episodes/16, but
    // Trakt's web app has no episode pages any more: it bounces that URL through
    // a sign-in check and lands on the show. Link straight to the show so the
    // link goes where it says it goes.
    const path = ids.trakt.replace(/^(shows\/[^/]+)\/seasons\/.*$/, '$1');
    return 'https://trakt.tv/' + path;
  }

  /**
   * Built from t.lbx / t.trakt so either resolver can repaint without erasing
   * the other's button. Letterboxd starts out `undefined`, which renders the
   * button optimistically: its /imdb/ redirect URL is valid with no network at
   * all, so the link is clickable in the first paint and the lookup only
   * upgrades the href, or removes the button when Letterboxd has no page.
   */
  function actionsHtml(t) {
    const parts = [];
    if (LETTERBOXD_TYPES.test(t.typeId) && t.lbx !== null) {
      const href = (t.lbx && safeUrl(t.lbx.url)) || letterboxdRedirect(t.id);
      parts.push(interpolate(html`
        <a class="imdbc-btn imdbc-ext" data-imdbc-lbx href="${href}" target="_blank" rel="noopener noreferrer">
          ${raw(MARKS.letterboxd)}<span>Letterboxd</span></a>`));
    }
    if (t.trakt) {
      parts.push(interpolate(html`
        <a class="imdbc-btn imdbc-ext" data-imdbc-trakt href="${safeUrl(t.trakt)}" target="_blank" rel="noopener noreferrer">
          ${raw(MARKS.trakt)}<span>Trakt</span></a>`));
    }
    return parts.join('');
  }

  function paintActions(root, t) {
    const host = root.querySelector('[data-imdbc-actions]');
    if (host) host.innerHTML = actionsHtml(t);
  }

  /**
   * The two lookups hit different services and are resolved independently: a
   * slow Wikidata must not hold back a Letterboxd result already on disk.
   */
  function wireExternalLinks(root, t) {
    const token = renderSeq;
    const fresh = () => token === renderSeq && root.isConnected;

    if (LETTERBOXD_TYPES.test(t.typeId)) {
      letterboxdInfo(t.id).catch(() => undefined).then((lbx) => {
        if (!fresh()) return;
        // A failed lookup keeps the button (the redirect URL still works) but
        // must still clear the score tile out of its pending state.
        t.lbx = lbx === undefined ? null : lbx;
        repaintScores(root, t);
        paintActions(root, t);
      });
    } else {
      t.lbx = null;
    }

    traktUrl(t.id, t.typeId).catch(() => undefined).then((url) => {
      if (!fresh()) return;
      t.trakt = url || null;
      paintActions(root, t);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. Styles
  // ══════════════════════════════════════════════════════════════════════════

  const CSS = `
:root, html.imdbc-on {
  --imdbc-bg: #f6f7f9;
  --imdbc-panel: #ffffff;
  --imdbc-panel-2: #eef0f4;
  --imdbc-border: #dcdfe6;
  --imdbc-text: #14171c;
  --imdbc-muted: #4f5866;
  --imdbc-faint: #6e7786;
  --imdbc-accent: #b8860b;
  --imdbc-star: #d4a017;
  --imdbc-link: #14539a;
  --imdbc-fresh: #c0392b;
  --imdbc-rotten: #3f7a3f;
  --imdbc-popcorn: #c77b1a;
  --imdbc-meta: #2f7d4f;
  --imdbc-shadow: 0 1px 2px rgba(16,20,28,.06);

  /* Fluid type: grows with the viewport instead of sitting at a fixed small
     size on a large screen, and stops before lines get unwieldy. */
  --fs-micro: clamp(12.5px, 0.10vw + 12.1px, 13.5px);
  --fs-tiny:  clamp(13px,   0.16vw + 12.4px, 14.5px);
  --fs-small: clamp(14px,   0.20vw + 13.2px, 15.5px);
  --fs-body:  clamp(15px,   0.26vw + 14.0px, 17px);
  --fs-item:  clamp(15.5px, 0.26vw + 14.5px, 17.5px);
  --fs-lead:  clamp(16px,   0.30vw + 14.9px, 18.5px);
  --fs-h2:    clamp(19px,   0.55vw + 16.8px, 25px);
  --fs-val:   clamp(22px,   0.55vw + 19.8px, 28px);
}
html.imdbc-on.imdbc-dark {
  --imdbc-bg: #0e1014;
  --imdbc-panel: #171a21;
  --imdbc-panel-2: #1f2430;
  --imdbc-border: #2a3040;
  --imdbc-text: #e8eaf0;
  --imdbc-muted: #a6b0c0;
  --imdbc-faint: #828d9f;
  --imdbc-accent: #f5c518;
  --imdbc-star: #f5c518;
  --imdbc-link: #7fb3ff;
  --imdbc-fresh: #ff5b4a;
  --imdbc-rotten: #7ec87e;
  --imdbc-popcorn: #ffbf47;
  --imdbc-meta: #6fd39a;
  --imdbc-shadow: none;
}

html.imdbc-on { background: var(--imdbc-bg) !important; }
html.imdbc-on body {
  background: var(--imdbc-bg) !important;
  overflow: auto !important;
  margin: 0 !important;
  padding: 0 !important;
}
html.imdbc-on body > *:not(#imdbc-root):not(script):not(style):not(link) { display: none !important; }
html.imdbc-on #imdbc-root { display: block; }
html.imdbc-off #imdbc-root { display: none !important; }

#imdbc-root {
  color: var(--imdbc-text);
  font: 400 var(--fs-body)/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding-bottom: 96px;
}
#imdbc-root *, #imdbc-root *::before, #imdbc-root *::after { box-sizing: border-box; }
:where(#imdbc-root) a { color: inherit; text-decoration: none; }
:where(#imdbc-root) a:hover { text-decoration: underline; text-underline-offset: 2px; }
#imdbc-root img { display: block; max-width: 100%; }
:where(#imdbc-root) button { font: inherit; color: inherit; }
#imdbc-root :focus-visible { outline: 2px solid var(--imdbc-link); outline-offset: 2px; border-radius: 4px; }

.imdbc-wrap { max-width: 1240px; margin: 0 auto; padding: 0 28px; }

/* ── top bar ───────────────────────────────────────────────────────────── */
.imdbc-bar {
  position: sticky; top: 0; z-index: 40;
  background: color-mix(in srgb, var(--imdbc-bg) 88%, transparent);
  backdrop-filter: saturate(160%) blur(10px);
  border-bottom: 1px solid var(--imdbc-border);
}
.imdbc-bar-in { max-width: 1240px; margin: 0 auto; padding: 11px 28px; display: flex; gap: 14px; align-items: center; }
.imdbc-brand { font-weight: 700; letter-spacing: -.01em; font-size: var(--fs-small); color: var(--imdbc-muted); white-space: nowrap; }
.imdbc-brand b { color: var(--imdbc-accent); }
.imdbc-bar form { flex: 1 1 auto; min-width: 80px; display: flex; }
.imdbc-bar input[type="search"] {
  width: 100%; padding: 7px 12px; border-radius: 999px;
  border: 1px solid var(--imdbc-border); background: var(--imdbc-panel);
  color: var(--imdbc-text); font: inherit; font-size: var(--fs-small);
}
.imdbc-bar-actions { display: flex; gap: 6px; flex: 0 0 auto; }

.imdbc-btn {
  border: 1px solid var(--imdbc-border); background: var(--imdbc-panel);
  border-radius: 8px; padding: 7px 13px; font-size: var(--fs-small); cursor: pointer;
  white-space: nowrap; transition: background .12s ease, border-color .12s ease;
}
.imdbc-btn:hover { background: var(--imdbc-panel-2); }
.imdbc-btn[aria-pressed="true"], .imdbc-btn.is-on {
  background: var(--imdbc-text); color: var(--imdbc-bg); border-color: var(--imdbc-text);
}
.imdbc-btn-ghost { background: transparent; border-color: transparent; color: var(--imdbc-muted); }
.imdbc-btn-ghost:hover { background: var(--imdbc-panel-2); color: var(--imdbc-text); }

/* ── hero ──────────────────────────────────────────────────────────────── */
.imdbc-hero { display: grid; grid-template-columns: 200px 1fr; gap: 26px; padding: 26px 0 8px; }
.imdbc-hero-poster {
  width: 200px; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border);
}
.imdbc-hero-poster img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-h1 { margin: 0; font-size: clamp(26px, 3.4vw, 38px); line-height: 1.12; letter-spacing: -.022em; font-weight: 700; }
.imdbc-sub { margin: 9px 0 0; color: var(--imdbc-muted); font-size: var(--fs-small); display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.imdbc-sub .dot { color: var(--imdbc-faint); }
.imdbc-orig { margin: 5px 0 0; color: var(--imdbc-faint); font-size: var(--fs-small); font-style: italic; }
.imdbc-plot { margin: 16px 0 0; max-width: 64ch; font-size: var(--fs-lead); line-height: 1.6; color: var(--imdbc-text); }
.imdbc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 13px 0 0; }
.imdbc-chip {
  font-size: var(--fs-small); padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--imdbc-border); background: var(--imdbc-panel); color: var(--imdbc-muted);
}
.imdbc-crew { margin: 16px 0 0; font-size: var(--fs-small); line-height: 1.5; display: grid; gap: 6px; }
.imdbc-crew .k { color: var(--imdbc-faint); }
.imdbc-crew a { color: var(--imdbc-link); }

/* ── score strip ───────────────────────────────────────────────────────── */
.imdbc-scores { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 0; }


/* ── sections ──────────────────────────────────────────────────────────── */
.imdbc-sec { margin: 40px 0 0; }
.imdbc-sec-head {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  padding-bottom: 9px; border-bottom: 1px solid var(--imdbc-border); margin-bottom: 18px;
}
.imdbc-sec-head h2 { margin: 0; font-size: var(--fs-h2); letter-spacing: -.018em; font-weight: 700; }
.imdbc-sec-head .count { color: var(--imdbc-faint); font-size: var(--fs-small); font-weight: 500; }
.imdbc-sec-head .spacer { flex: 1 1 auto; }
.imdbc-tools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.imdbc-tools input[type="search"], .imdbc-tools select {
  padding: 5px 10px; border-radius: 8px; border: 1px solid var(--imdbc-border);
  background: var(--imdbc-panel); color: var(--imdbc-text); font: inherit; font-size: var(--fs-small);
}

/* ── cast grid ─────────────────────────────────────────────────────────── */
.imdbc-cast { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(178px, 46%), 1fr)); gap: 18px; }
.imdbc-person { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.imdbc-person .ph {
  width: 100%; aspect-ratio: 2 / 3; border-radius: 9px; overflow: hidden;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border);
  display: grid; place-items: center; color: var(--imdbc-faint);
  font-size: var(--fs-lead); font-weight: 500; letter-spacing: .06em; opacity: .5;
}
.imdbc-person .ph img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-person .nm { font-weight: 600; font-size: var(--fs-item); line-height: 1.35; }
.imdbc-person .ch { font-size: var(--fs-small); color: var(--imdbc-muted); line-height: 1.4; }
.imdbc-person .ep { font-size: var(--fs-tiny); color: var(--imdbc-faint); }
.imdbc-person .attr { font-size: var(--fs-tiny); color: var(--imdbc-faint); font-style: italic; }

/* ── seasons ───────────────────────────────────────────────────────────── */
.imdbc-seasons { display: flex; flex-wrap: wrap; gap: 8px; }
.imdbc-season {
  border: 1px solid var(--imdbc-border); background: var(--imdbc-panel); border-radius: 9px;
  padding: 8px 14px; min-width: 88px; text-align: center;
}
.imdbc-season .s { font-size: var(--fs-micro); letter-spacing: .05em; text-transform: uppercase; color: var(--imdbc-faint); }
.imdbc-season .e { font-size: var(--fs-lead); font-weight: 700; letter-spacing: -.02em; }
.imdbc-season .e small { font-size: var(--fs-tiny); font-weight: 500; color: var(--imdbc-muted); }

/* ── reviews ───────────────────────────────────────────────────────────── */
.imdbc-reviews { display: grid; gap: 14px; }
.imdbc-review {
  border: 1px solid var(--imdbc-border); background: var(--imdbc-panel); box-shadow: var(--imdbc-shadow);
  border-radius: 11px; padding: 15px 17px;
}
.imdbc-review-top { display: flex; gap: 11px; align-items: baseline; flex-wrap: wrap; }
.imdbc-rv-rating {
  flex: 0 0 auto; font-weight: 700; font-size: var(--fs-item);
  background: var(--imdbc-panel-2); border-radius: 7px; padding: 2px 9px;
}
.imdbc-rv-sum { font-weight: 650; font-size: var(--fs-lead); flex: 1 1 200px; min-width: 0; letter-spacing: -.01em; line-height: 1.35; }
.imdbc-rv-meta { font-size: var(--fs-small); color: var(--imdbc-faint); }
.imdbc-rv-meta a { color: var(--imdbc-link); }
.imdbc-rv-body {
  margin-top: 11px; white-space: pre-wrap; font-size: var(--fs-lead); line-height: 1.68; max-width: 76ch;
  color: var(--imdbc-text); overflow: hidden; position: relative;
}
.imdbc-rv-body.clamped { max-height: 8.2em; }
.imdbc-rv-body.clamped::after {
  content: ''; position: absolute; inset: auto 0 0 0; height: 3.4em;
  background: linear-gradient(to bottom, transparent, var(--imdbc-panel));
}
.imdbc-rv-body.spoiler { filter: blur(5px); cursor: pointer; user-select: none; }
.imdbc-rv-foot { margin-top: 12px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: var(--fs-small); color: var(--imdbc-faint); }
.imdbc-spoiler-tag { color: var(--imdbc-fresh); font-weight: 600; font-size: var(--fs-tiny); }

/* ── title cards row ───────────────────────────────────────────────────── */
.imdbc-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(172px, 46%), 1fr)); gap: 20px; }
.imdbc-card { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.imdbc-card .po {
  width: 100%; aspect-ratio: 2 / 3; border-radius: 9px; overflow: hidden;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border);
}
.imdbc-card .po img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-card .ti { font-weight: 600; font-size: var(--fs-item); line-height: 1.35; }
.imdbc-card .mt { font-size: var(--fs-small); color: var(--imdbc-faint); display: flex; gap: 10px; flex-wrap: wrap; }
.imdbc-card .rt { font-weight: 600; }

/* ── credits table (person pages) ──────────────────────────────────────── */
.imdbc-credits { display: grid; gap: 2px; }
.imdbc-credit {
  display: grid; grid-template-columns: 58px 52px 1fr auto; gap: 16px; align-items: center;
  padding: 12px; border-radius: 10px; border: 1px solid transparent;
}
.imdbc-credit:hover { background: var(--imdbc-panel); border-color: var(--imdbc-border); }
.imdbc-credit .yr { color: var(--imdbc-faint); font-variant-numeric: tabular-nums; font-size: var(--fs-small); }
.imdbc-credit .po {
  width: 52px; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border);
}
.imdbc-credit .po img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-credit .main { min-width: 0; }
.imdbc-credit .ti { font-weight: 600; font-size: var(--fs-item); line-height: 1.38; }
.imdbc-credit .ti .tt { color: var(--imdbc-faint); font-weight: 500; font-size: var(--fs-tiny); margin-left: 8px; }
.imdbc-credit .role { font-size: var(--fs-small); color: var(--imdbc-muted); line-height: 1.45; }
.imdbc-credit .role b { color: var(--imdbc-text); font-weight: 600; }
.imdbc-credit .eps { font-size: var(--fs-tiny); color: var(--imdbc-faint); }
.imdbc-credit .rt { font-weight: 700; font-size: var(--fs-item); font-variant-numeric: tabular-nums; white-space: nowrap; }
.imdbc-credit .rt small { color: var(--imdbc-faint); font-weight: 400; }

/* ── known for ─────────────────────────────────────────────────────────── */
.imdbc-knownfor { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(190px, 46%), 1fr)); gap: 22px; }

/* ── bio ───────────────────────────────────────────────────────────────── */
.imdbc-bio { max-width: 70ch; white-space: pre-wrap; font-size: var(--fs-lead); line-height: 1.62; position: relative; overflow: hidden; }
.imdbc-bio.clamped { max-height: 7.2em; }
.imdbc-bio.clamped::after {
  content: ''; position: absolute; inset: auto 0 0 0; height: 3em;
  background: linear-gradient(to bottom, transparent, var(--imdbc-bg));
}

/* ── misc ──────────────────────────────────────────────────────────────── */
.imdbc-more { margin-top: 16px; display: flex; gap: 10px; justify-content: center; }
.imdbc-empty { color: var(--imdbc-faint); font-size: var(--fs-body); padding: 8px 0; }
.imdbc-note { color: var(--imdbc-faint); font-size: var(--fs-small); }
.imdbc-loading { color: var(--imdbc-faint); font-size: var(--fs-small); display: inline-flex; gap: 8px; align-items: center; }
.imdbc-loading::before {
  content: ''; width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid var(--imdbc-border); border-top-color: var(--imdbc-muted);
  animation: imdbc-spin .7s linear infinite;
}
@keyframes imdbc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .imdbc-loading::before { animation: none; } }

.imdbc-fail {
  max-width: 640px; margin: 64px auto; padding: 22px 24px; border-radius: 12px;
  border: 1px solid var(--imdbc-border); background: var(--imdbc-panel);
}
.imdbc-fail h2 { margin: 0 0 10px; font-size: var(--fs-h2); }

.imdbc-panel-pop {
  position: absolute; right: 20px; top: 52px; z-index: 60; width: 292px;
  background: var(--imdbc-panel); border: 1px solid var(--imdbc-border);
  border-radius: 11px; padding: 14px 16px; box-shadow: 0 10px 34px rgba(0,0,0,.22);
}
.imdbc-panel-pop h3 { margin: 0 0 12px; font-size: var(--fs-item); }
.imdbc-set-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; font-size: var(--fs-small); }
.imdbc-set-row select { padding: 3px 8px; border-radius: 7px; border: 1px solid var(--imdbc-border); background: var(--imdbc-panel-2); color: var(--imdbc-text); font: inherit; font-size: var(--fs-small); }

/* ── rating bands ──────────────────────────────────────────────────────── */
:root, html.imdbc-on {
  --rb-top: #1a7f37;
  --rb-high: #4a7f1a;
  --rb-mid: #a86a00;
  --rb-low: #b3261e;
}
html.imdbc-on.imdbc-dark {
  --rb-top: #4ade80;
  --rb-high: #a9d94b;
  --rb-mid: #f7b733;
  --rb-low: #f2695f;
}
.rb-top { color: var(--rb-top); }
.rb-high { color: var(--rb-high); }
.rb-mid { color: var(--rb-mid); }
.rb-low { color: var(--rb-low); }
.rb-thin { opacity: .62; }
.rb-thin small { opacity: .85; }

/* The tile keeps its brand mark and edge for identity; the number carries the band. */
.imdbc-score.rb-top .val { color: var(--rb-top); }
.imdbc-score.rb-high .val { color: var(--rb-high); }
.imdbc-score.rb-mid .val { color: var(--rb-mid); }
.imdbc-score.rb-low .val { color: var(--rb-low); }

/* ── score tiles ───────────────────────────────────────────────────────── */
.imdbc-score {
  display: grid; gap: 2px; align-content: start;
  border: 1px solid var(--imdbc-border); border-left: 3px solid var(--brand, var(--imdbc-border));
  background: var(--imdbc-panel); box-shadow: var(--imdbc-shadow);
  border-radius: 10px; padding: 11px 16px 12px; min-width: 142px;
}
a.imdbc-score:hover { border-color: var(--brand, var(--imdbc-border)); text-decoration: none; }
.imdbc-score .site { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.imdbc-score .site .nm {
  font-size: var(--fs-micro); letter-spacing: .04em; text-transform: uppercase;
  color: var(--imdbc-muted); font-weight: 650; white-space: nowrap;
}
.imdbc-score .val { font-size: var(--fs-val); font-weight: 700; line-height: 1.2; letter-spacing: -.02em; color: var(--brand, var(--imdbc-text)); }
.imdbc-score .val small { font-size: var(--fs-small); font-weight: 500; color: var(--imdbc-faint); letter-spacing: 0; }
.imdbc-score .sub { font-size: var(--fs-tiny); color: var(--imdbc-muted); }
.imdbc-score.is-pending .val { min-height: 26px; }

.imdbc-score[data-site="imdb"] { --brand: var(--imdbc-star); }
.imdbc-score[data-site="tomato"] { --brand: var(--imdbc-fresh); }
.imdbc-score[data-site="popcorn"] { --brand: var(--imdbc-popcorn); }
.imdbc-score[data-site="letterboxd"] { --brand: #40BCF4; }
.imdbc-score[data-site="metacritic"] { --brand: var(--imdbc-meta); }

.mk { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; }
.mk-svg { width: 15px; height: 15px; }
.mk-lbx { width: 26px; height: 10.4px; }
.mk-imdb {
  background: #f5c518; color: #000; font: 800 9.5px/1 Verdana, system-ui, sans-serif;
  letter-spacing: -.02em; padding: 3px 4px; border-radius: 3px;
}
.mk-mc {
  background: #2b2b2e; color: #fff; font: 800 11px/1 Georgia, serif;
  width: 16px; height: 16px; border-radius: 3px;
}

.imdbc-score .imdbc-loading { font-size: 0; }
.imdbc-score .imdbc-loading::before { width: 14px; height: 14px; margin-top: 5px; }

/* ── external links ────────────────────────────────────────────────────── */
.imdbc-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; }
.imdbc-ext { display: inline-flex; align-items: center; gap: 9px; padding: 8px 14px; }
.imdbc-ext .mk-lbx { width: 26px; height: 10.4px; }

/* ── trailer and videos ────────────────────────────────────────────────── */
.imdbc-player { max-width: 860px; }
.imdbc-vhero {
  position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; padding: 0;
  border-radius: 12px; overflow: hidden; border: 1px solid var(--imdbc-border);
  background: var(--imdbc-panel-2); cursor: pointer;
}
.imdbc-vhero.is-loading { display: grid; place-items: center; cursor: default; aspect-ratio: auto; padding: 40px 16px; }
.imdbc-vhero img { width: 100%; height: 100%; object-fit: cover; display: block; }
.imdbc-vhero .play {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 68px; height: 68px; border-radius: 50%; background: rgba(0,0,0,.62);
  border: 2px solid rgba(255,255,255,.9); transition: background .12s ease;
}
.imdbc-vhero .play::after {
  content: ''; position: absolute; left: 52%; top: 50%; transform: translate(-50%, -50%);
  border-style: solid; border-width: 13px 0 13px 21px; border-color: transparent transparent transparent #fff;
}
.imdbc-vhero:hover .play { background: rgba(0,0,0,.8); }
.imdbc-vhero .meta {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 30px 16px 12px; text-align: left;
  color: #fff; font-size: var(--fs-small);
  background: linear-gradient(to top, rgba(0,0,0,.82), transparent);
}
.imdbc-video { width: 100%; aspect-ratio: 16 / 9; border-radius: 12px; background: #000; display: block; }
.imdbc-vcaption { margin-top: 8px; font-size: var(--fs-small); color: var(--imdbc-muted); }

.imdbc-vstrip { display: flex; gap: 12px; overflow-x: auto; padding: 16px 2px 4px; }
.imdbc-vthumb {
  flex: 0 0 auto; width: 176px; background: none; border: 1px solid transparent;
  border-radius: 10px; padding: 6px; cursor: pointer; text-align: left;
}
.imdbc-vthumb:hover, .imdbc-vthumb.is-on { background: var(--imdbc-panel); border-color: var(--imdbc-border); }
.imdbc-vthumb .th {
  position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: 7px;
  overflow: hidden; background: var(--imdbc-panel-2);
}
.imdbc-vthumb .th img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-vthumb .dur {
  position: absolute; right: 5px; bottom: 5px; background: rgba(0,0,0,.78); color: #fff;
  font-size: 11px; padding: 1px 5px; border-radius: 4px; font-variant-numeric: tabular-nums;
}
.imdbc-vthumb .nm {
  display: block; margin-top: 7px; font-size: var(--fs-small); line-height: 1.34;
  color: var(--imdbc-muted); overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}

/* ── photos ────────────────────────────────────────────────────────────── */
.imdbc-photogrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 46%), 1fr)); gap: 10px; }
.imdbc-photo {
  padding: 0; border: 1px solid var(--imdbc-border); border-radius: 9px; overflow: hidden;
  background: var(--imdbc-panel-2); cursor: zoom-in; aspect-ratio: 3 / 2; display: block;
}
.imdbc-photo img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .18s ease; }
.imdbc-photo:hover img { transform: scale(1.04); }

.imdbc-lightbox {
  position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.93);
  display: grid; grid-template-columns: 64px 1fr 64px; align-items: center; padding: 24px;
}
.imdbc-lightbox figure { margin: 0; display: grid; gap: 12px; justify-items: center; min-height: 0; }
.imdbc-lightbox img { max-width: 100%; max-height: 82vh; object-fit: contain; border-radius: 8px; }
.imdbc-lightbox figcaption {
  color: #dfe3ea; font-size: var(--fs-small); text-align: center; max-width: 80ch;
  display: flex; gap: 14px; align-items: baseline; justify-content: center; flex-wrap: wrap;
}
.imdbc-lightbox .of { color: #8b93a3; font-variant-numeric: tabular-nums; }
.imdbc-lightbox .nav, .imdbc-lightbox .close {
  background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18); color: #fff;
  border-radius: 10px; cursor: pointer; font-size: 30px; line-height: 1; padding: 14px 0;
}
.imdbc-lightbox .nav:hover, .imdbc-lightbox .close:hover { background: rgba(255,255,255,.18); }
.imdbc-lightbox .close { position: absolute; top: 18px; right: 18px; font-size: 24px; padding: 6px 14px; }

@media (max-width: 760px) {
  .imdbc-lightbox { grid-template-columns: 44px 1fr 44px; padding: 12px; }
  .imdbc-lightbox .nav { font-size: 22px; }
  .imdbc-vthumb { width: 144px; }
}

/* ── title sub-pages ───────────────────────────────────────────────────── */
.imdbc-subhead { display: grid; grid-template-columns: 96px 1fr; gap: 22px; padding: 26px 0 6px; align-items: start; }
.imdbc-subhead .po {
  width: 96px; aspect-ratio: 2 / 3; border-radius: 9px; overflow: hidden;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border); display: block;
}
.imdbc-subhead .po img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-subhead .imdbc-h1 { font-size: clamp(22px, 2.4vw, 32px); }
.imdbc-subtabs { margin-top: 16px; }

/* histogram */
.imdbc-histogram { display: grid; gap: 7px; max-width: 760px; }
.imdbc-hrow { display: grid; grid-template-columns: 2.4em 1fr 5.5em 4em; gap: 14px; align-items: center; }
.imdbc-hrow .sc { font-weight: 700; font-size: var(--fs-item); font-variant-numeric: tabular-nums; text-align: right; }
.imdbc-hrow .bar { background: var(--imdbc-panel-2); border-radius: 5px; height: 15px; overflow: hidden; }
.imdbc-hrow .fill { display: block; height: 100%; border-radius: 5px; background: currentColor; min-width: 2px; }
.imdbc-hrow .ct { font-size: var(--fs-small); color: var(--imdbc-muted); font-variant-numeric: tabular-nums; text-align: right; }
.imdbc-hrow .pc { font-size: var(--fs-small); color: var(--imdbc-faint); font-variant-numeric: tabular-nums; text-align: right; }

.imdbc-hcountry { display: grid; grid-template-columns: 1fr 4em 8em; gap: 14px; align-items: center; padding: 9px 10px; border-radius: 8px; }
.imdbc-hcountry:hover { background: var(--imdbc-panel); }
.imdbc-hcountry .nm { font-size: var(--fs-item); font-weight: 600; }
.imdbc-hcountry .rt { font-weight: 700; font-size: var(--fs-item); text-align: right; font-variant-numeric: tabular-nums; }
.imdbc-hcountry .ct { font-size: var(--fs-small); color: var(--imdbc-faint); text-align: right; }

/* crew lists */
.imdbc-crewlist { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 4px 24px; }
.imdbc-crewrow { padding: 7px 10px; border-radius: 8px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.imdbc-crewrow:hover { background: var(--imdbc-panel); }
.imdbc-crewrow .nm { font-size: var(--fs-item); font-weight: 600; color: var(--imdbc-link); }
.imdbc-crewrow .rl { font-size: var(--fs-small); color: var(--imdbc-muted); }
.imdbc-crewrow .at { font-size: var(--fs-tiny); color: var(--imdbc-faint); font-style: italic; }

/* episodes */
.imdbc-eplist { display: grid; gap: 4px; }
.imdbc-ep {
  display: grid; grid-template-columns: 168px 1fr; gap: 18px; align-items: start;
  padding: 12px; border-radius: 11px; border: 1px solid transparent;
}
.imdbc-ep:hover { background: var(--imdbc-panel); border-color: var(--imdbc-border); text-decoration: none; }
.imdbc-ep .st {
  width: 168px; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border); display: block;
}
.imdbc-ep .st img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-ep .main { min-width: 0; display: grid; gap: 5px; }
.imdbc-ep .ti { font-size: var(--fs-lead); font-weight: 650; line-height: 1.35; }
.imdbc-ep .ti .no { color: var(--imdbc-faint); font-weight: 600; margin-right: 8px; font-variant-numeric: tabular-nums; }
.imdbc-ep .mt { font-size: var(--fs-small); color: var(--imdbc-faint); display: flex; gap: 14px; flex-wrap: wrap; align-items: baseline; }
.imdbc-ep .mt .rt { font-weight: 700; }
.imdbc-ep .pl {
  font-size: var(--fs-small); color: var(--imdbc-muted); line-height: 1.55; max-width: 78ch;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}

@media (max-width: 760px) {
  .imdbc-subhead { grid-template-columns: 74px 1fr; gap: 14px; }
  .imdbc-subhead .po { width: 74px; }
  .imdbc-ep { grid-template-columns: 124px 1fr; gap: 12px; }
  .imdbc-ep .st { width: 124px; }
  .imdbc-hrow { grid-template-columns: 2.2em 1fr 4.5em; gap: 10px; }
  .imdbc-hrow .pc { display: none; }
  .imdbc-hcountry { grid-template-columns: 1fr 3.4em 6em; gap: 10px; }
}

.imdbc-result.ranked { grid-template-columns: 2.6em 58px 1fr; }
.imdbc-result .rank {
  font-size: var(--fs-h2); font-weight: 700; color: var(--imdbc-faint);
  font-variant-numeric: tabular-nums; text-align: right; line-height: 1.2;
}
@media (max-width: 760px) {
  .imdbc-result.ranked { grid-template-columns: 2em 46px 1fr; }
  .imdbc-result .rank { font-size: var(--fs-item); }
}

/* ── search results ────────────────────────────────────────────────────── */
.imdbc-search-head { padding: 26px 0 4px; display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
.imdbc-search-head .imdbc-h1 { font-size: clamp(22px, 2.6vw, 30px); }
.imdbc-results { display: grid; gap: 2px; }
.imdbc-result {
  display: grid; grid-template-columns: 58px 1fr; gap: 16px; align-items: start;
  padding: 13px 12px; border-radius: 10px; border: 1px solid transparent;
}
.imdbc-result:hover { background: var(--imdbc-panel); border-color: var(--imdbc-border); text-decoration: none; }
.imdbc-result .po {
  width: 58px; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; display: grid; place-items: center;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border);
  color: var(--imdbc-faint); font-size: 14px; letter-spacing: .06em; opacity: .9;
}
.imdbc-result .po.round { aspect-ratio: 1 / 1; border-radius: 50%; }
.imdbc-result .po img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-result .main { min-width: 0; display: grid; gap: 3px; }
.imdbc-result .ti { font-weight: 650; font-size: var(--fs-item); line-height: 1.35; }
.imdbc-result .mt { font-size: var(--fs-small); color: var(--imdbc-faint); display: flex; gap: 14px; flex-wrap: wrap; }
.imdbc-result .mt .rt { font-weight: 600; }
.imdbc-result .pl {
  font-size: var(--fs-small); color: var(--imdbc-muted); line-height: 1.55; max-width: 78ch;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

/* ── search suggestions ────────────────────────────────────────────────── */
.imdbc-search { position: relative; width: 100%; }
.imdbc-suggest {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 70;
  background: var(--imdbc-panel); border: 1px solid var(--imdbc-border);
  border-radius: 11px; padding: 5px; box-shadow: 0 12px 36px rgba(0,0,0,.28);
  max-height: 68vh; overflow: auto;
}
.imdbc-sg { display: grid; grid-template-columns: 30px 1fr; gap: 10px; align-items: center; padding: 7px 8px; border-radius: 8px; }
.imdbc-sg:hover, .imdbc-sg.is-on { background: var(--imdbc-panel-2); text-decoration: none; }
.imdbc-sg .po {
  width: 30px; aspect-ratio: 2 / 3; border-radius: 4px; overflow: hidden;
  background: var(--imdbc-panel-2); border: 1px solid var(--imdbc-border);
}
.imdbc-sg .po img { width: 100%; height: 100%; object-fit: cover; }
.imdbc-sg .tx { min-width: 0; display: grid; }
.imdbc-sg .l { font-size: var(--fs-small); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.imdbc-sg .m { font-size: var(--fs-tiny); color: var(--imdbc-faint); }
.imdbc-sg .s { font-size: var(--fs-tiny); color: var(--imdbc-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

@media (max-width: 760px) {
  .imdbc-result { grid-template-columns: 46px 1fr; gap: 12px; }
  .imdbc-result .po { width: 46px; }
}

@media (max-width: 760px) {
  .imdbc-hero { grid-template-columns: 116px 1fr; gap: 16px; padding-top: 18px; }
  .imdbc-hero-poster { width: 116px; }
  .imdbc-cast, .imdbc-cards, .imdbc-knownfor { gap: 14px; }
  .imdbc-credit { grid-template-columns: 46px 44px 1fr; gap: 12px; row-gap: 5px; padding: 11px 8px; }
  .imdbc-credit .po { width: 44px; }
  .imdbc-credit .rt { grid-column: 3; justify-self: start; }
  .imdbc-wrap { padding: 0 14px; }
  .imdbc-bar-in { padding: 8px 14px; }
}
@media (max-width: 460px) {
  .imdbc-hero { grid-template-columns: 1fr; }
  .imdbc-hero-poster { width: 132px; }
  .imdbc-brand { display: none; }
}
`;

  // ══════════════════════════════════════════════════════════════════════════
  // 9b. Cookie consent banner — hide it, then decline it
  // ══════════════════════════════════════════════════════════════════════════

  // IMDb's consent banner is styled-components markup, so every class name is a
  // build hash and useless as a hook. The three buttons carry stable
  // data-testid attributes, and the banner's root is a direct child of #__next.
  // The :not(:has(h1)) guard means that if IMDb ever moves the button inside the
  // main content wrapper, this rule stops matching instead of blanking the page.
  const CONSENT_CSS = `
#__next > div:has([data-testid="reject-button"]):has([data-testid="accept-button"]):not(:has(h1)):not(:has(main)):not(:has(nav)):not(:has(header)) { display: none !important; }
[data-imdbc-consent-hidden] { display: none !important; }
`;

  function consentBannerRoot(btn) {
    let el = btn;
    while (el.parentElement && el.parentElement.id !== '__next' && el.parentElement !== document.body) {
      el = el.parentElement;
    }
    return el;
  }

  let consentDone = false;
  function dismissConsent() {
    if (consentDone || !settings.declineCookies) return;
    const reject = document.querySelector('[data-testid="reject-button"]');
    if (!reject) return;

    const root = consentBannerRoot(reject);
    // Only hide a subtree that really is just the banner: it must hold the
    // accept button too, and must not contain the page heading.
    const isBanner = root && root !== document.body
      && root.querySelector('[data-testid="accept-button"]')
      && !root.querySelector('h1, main, nav, header');

    // Click first: a hidden element still dispatches, but declining while the
    // node is live is the behaviour IMDb's own handler expects.
    try { reject.click(); } catch (e) { warn('could not click decline', e); }
    if (isBanner) root.setAttribute('data-imdbc-consent-hidden', '');
    consentDone = true;
  }

  function watchConsent() {
    if (!settings.declineCookies) return;
    injectStyle('imdbc-consent-style', CONSENT_CSS);
    dismissConsent();
    let obs;
    try {
      obs = new MutationObserver(() => {
        dismissConsent();
        if (consentDone && obs) obs.disconnect();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { warn('consent observer failed', e); }
    // The banner mounts after hydration; stop watching once it plainly is not coming.
    setTimeout(() => { if (obs) obs.disconnect(); }, 20000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. Boot-time page suppression
  // ══════════════════════════════════════════════════════════════════════════

  function injectStyle(id, css) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function applyTheme() {
    const wantDark = settings.theme === 'dark'
      || (settings.theme === 'auto' && window.matchMedia
        && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('imdbc-dark', wantDark);
  }

  function takeOver() {
    injectStyle('imdbc-style', CSS);
    document.documentElement.classList.add('imdbc-on');
    document.documentElement.classList.remove('imdbc-off');
    applyTheme();
  }

  function release() {
    document.documentElement.classList.remove('imdbc-on');
    document.documentElement.classList.add('imdbc-off');
  }

  const warn = (...args) => { try { console.warn('[Recut]', ...args); } catch (_) { /* noop */ } };

  /**
   * IMDb's React tree stays in the DOM (removing it makes its own scripts
   * throw); it is only hidden. Hidden autoplaying trailers would still make
   * noise, so mute and pause anything outside our root.
   */
  function silenceBackgroundMedia() {
    const hush = () => {
      for (const m of document.querySelectorAll('video, audio')) {
        if (m.closest('#imdbc-root')) continue;
        try { m.muted = true; if (!m.paused) m.pause(); } catch (_) { /* noop */ }
      }
    };
    hush();
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      // Coalesce: IMDb mutates constantly, and hush() walks the whole document.
      setTimeout(() => { queued = false; hush(); }, 250);
    });
    try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) { /* noop */ }
    // React can restart playback after hydration; a few spaced retries cover it.
    [400, 1200, 3000, 6000].forEach((ms) => setTimeout(hush, ms));
    // Players are mounted during load. Past that, stop paying for the observer.
    setTimeout(() => { try { obs.disconnect(); } catch (_) { /* noop */ } hush(); }, 20000);
    return obs;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 11. Shared rendering pieces
  // ══════════════════════════════════════════════════════════════════════════

  function topBar(imdbHref, prefill) {
    return html`
      <div class="imdbc-bar">
        <div class="imdbc-bar-in">
          <div class="imdbc-brand"><a href="https://www.imdb.com/">Re<b>cut</b></a></div>
          <form action="https://www.imdb.com/find/" method="get" role="search" autocomplete="off">
            <div class="imdbc-search">
              <input type="search" name="q" placeholder="Search IMDb" aria-label="Search IMDb"
                     autocomplete="off" spellcheck="false" value="${prefill || ''}"
                     data-imdbc-q role="combobox" aria-expanded="false" aria-autocomplete="list">
              <div class="imdbc-suggest" data-imdbc-suggest hidden role="listbox"></div>
            </div>
          </form>
          <div class="imdbc-bar-actions">
            <a class="imdbc-btn imdbc-btn-ghost" href="${safeUrl(imdbHref)}" data-imdbc-original>Original page</a>
            <button type="button" class="imdbc-btn imdbc-btn-ghost" data-imdbc-settings aria-haspopup="dialog">Settings</button>
          </div>
        </div>
      </div>`;
  }

  /**
   * Type-ahead against the endpoint IMDb's own header uses. The point is to land
   * on a clean title or person page directly, instead of bouncing through the
   * results page for a title you already know the name of.
   */
  function wireSuggest(root) {
    const input = root.querySelector('[data-imdbc-q]');
    const box = root.querySelector('[data-imdbc-suggest]');
    if (!input || !box) return;

    let items = [];
    let active = -1;
    let timer = null;
    let seq = 0;

    const close = () => {
      box.hidden = true;
      box.innerHTML = '';
      items = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
    };

    const paint = () => {
      if (!items.length) { close(); return; }
      box.innerHTML = items.map((d, i) => {
        const img = thumb(d.image, 64, 96, d.imageSize);
        const meta = [d.year, d.type].filter(Boolean).join(' · ');
        return `<a class="imdbc-sg${i === active ? ' is-on' : ''}" role="option" href="${esc(d.href)}" data-i="${i}">`
          + `<span class="po">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}</span>`
          + `<span class="tx"><span class="l">${esc(d.label)}</span>`
          + (meta ? `<span class="m">${esc(meta)}</span>` : '')
          + (d.sub ? `<span class="s">${esc(d.sub)}</span>` : '')
          + '</span></a>';
      }).join('');
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    async function lookup(q) {
      const mine = ++seq;
      // IMDb's endpoint is keyed by the first character of the query.
      const key = q.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '').slice(0, 60);
      if (!key) { close(); return; }
      const url = 'https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(key) + '.json?includeVideos=0';
      let json;
      try {
        json = JSON.parse(await netGet(url, { headers: { Accept: 'application/json' }, timeout: 8000 }));
      } catch (e) {
        warn('suggest failed', e);
        return;
      }
      if (mine !== seq || !root.isConnected) return;
      items = (json.d || [])
        .filter((d) => d && typeof d.id === 'string' && /^(tt|nm)\d+$/.test(d.id))
        .slice(0, 8)
        .map((d) => ({
          href: d.id.startsWith('tt') ? titleUrl(d.id) : nameUrl(d.id),
          label: d.l || '',
          year: d.y ? String(d.y) : '',
          type: d.id.startsWith('nm') ? 'Person' : (d.q || ''),
          sub: d.s || '',
          image: (d.i && d.i.imageUrl) || '',
          imageSize: imgSize(d.i)
        }));
      active = -1;
      paint();
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(() => lookup(q), 180);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1) - 0;
        if (active >= items.length) active = -1;
        paint();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        location.href = items[active].href;
      }
    });

    box.addEventListener('mousedown', (e) => {
      const a = e.target.closest('.imdbc-sg');
      if (a) { e.preventDefault(); location.href = a.getAttribute('href'); }
    });

    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12b. Search results
  // ══════════════════════════════════════════════════════════════════════════

  const findUrl = (q, section) => 'https://www.imdb.com/find/?q=' + encodeURIComponent(q)
    + (section ? '&s=' + encodeURIComponent(section) : '');

  /**
   * IMDb's /find page ships its results in the same payload as everything else.
   * Shapes observed live: a title's fields sit on `listItem` with flat
   * `releaseYear`/`endYear` numbers (not the `releaseYear{}` object the title
   * page uses), and a name's `knownFor` is a single object, not an array.
   */
  function normaliseSearch(pp, route) {
    const meta = pp.findPageMeta || {};

    const titles = ((pp.titleResults && pp.titleResults.results) || []).map((r) => {
      const li = r.listItem || {};
      const start = li.releaseYear;
      const end = li.endYear;
      return {
        id: li.titleId || r.index,
        title: li.titleText || li.originalTitleText || '',
        year: start ? (end && end !== start ? `${start}–${end}` : String(start)) : '',
        typeText: (li.titleType && li.titleType.text) || '',
        certificate: li.certificate || '',
        genres: Array.isArray(li.genres) ? li.genres : [],
        plot: li.plot || '',
        poster: (li.primaryImage && li.primaryImage.url) || '',
        posterSize: imgSize(li.primaryImage),
        rating: li.ratingSummary && li.ratingSummary.aggregateRating,
        votes: li.ratingSummary && li.ratingSummary.voteCount,
        runtime: runtimeText(li.runtime && (li.runtime.seconds || li.runtime))
      };
    }).filter((t) => t.id && t.title);

    const names = ((pp.nameResults && pp.nameResults.results) || []).map((r) => {
      const li = r.listItem || {};
      const kf = li.knownFor;
      return {
        id: li.nameId || r.index,
        name: li.nameText || '',
        photo: (li.primaryImage && li.primaryImage.url) || '',
        photoSize: imgSize(li.primaryImage),
        professions: (li.professions || li.primaryProfessions || []).filter(Boolean),
        knownFor: kf && (kf.titleId || kf.titleText)
          ? { id: kf.titleId, title: kf.titleText || kf.originalTitleText, year: yearText(kf.yearRange) }
          : null
      };
    }).filter((p) => p.id && p.name);

    return {
      query: meta.searchTerm || route.query,
      section: route.section || '',
      titles,
      names,
      moreTitles: !!(pp.titleResults && pp.titleResults.nextCursor)
    };
  }

  function searchTitleRow(t) {
    const poster = thumb(t.poster, 96, 144, t.posterSize);
    const bits = [t.year, t.typeText && t.typeText !== 'Movie' ? t.typeText : '', t.runtime, t.certificate].filter(Boolean);
    return html`
      <a class="imdbc-result" href="${titleUrl(t.id)}">
        <span class="po">${poster ? html`<img src="${poster}" alt="" loading="lazy" decoding="async">` : ''}</span>
        <span class="main">
          <span class="ti">${t.title}</span>
          <span class="mt">
            ${bits.length ? html`<span>${bits.join(' · ')}</span>` : ''}
            ${typeof t.rating === 'number' ? html`<span class="rt ${ratingClasses(t.rating, 10, t.votes)}">★ ${t.rating.toFixed(1)}</span>` : ''}
            ${t.genres.length ? html`<span>${t.genres.slice(0, 3).join(', ')}</span>` : ''}
          </span>
          ${t.plot ? html`<span class="pl">${t.plot}</span>` : ''}
        </span>
      </a>`;
  }

  function searchNameRow(p) {
    const photo = thumb(p.photo, 96, 144, p.photoSize);
    return html`
      <a class="imdbc-result" href="${nameUrl(p.id)}">
        <span class="po round">${photo ? html`<img src="${photo}" alt="" loading="lazy" decoding="async">` : initials(p.name)}</span>
        <span class="main">
          <span class="ti">${p.name}</span>
          ${p.professions.length ? html`<span class="mt"><span>${p.professions.slice(0, 3).join(', ')}</span></span>` : ''}
          ${p.knownFor ? html`<span class="pl">Known for ${p.knownFor.title}${p.knownFor.year ? ` (${p.knownFor.year})` : ''}</span>` : ''}
        </span>
      </a>`;
  }

  function renderSearch(root, s) {
    const tab = (label, section) => html`<a class="imdbc-btn${s.section === section ? ' is-on' : ''}" href="${findUrl(s.query, section)}">${label}</a>`;
    const nothing = !s.titles.length && !s.names.length;

    root.innerHTML = interpolate(html`
      ${topBar(findUrl(s.query, s.section), s.query)}
      <div class="imdbc-wrap">
        <div class="imdbc-search-head">
          <h1 class="imdbc-h1">${s.query}</h1>
          <div class="imdbc-tools">
            ${tab('Everything', '')}
            ${tab('Titles', 'tt')}
            ${tab('People', 'nm')}
          </div>
        </div>

        ${nothing ? html`<div class="imdbc-empty" style="padding:28px 0">Nothing found. <a href="${findUrl(s.query, '')}" class="imdbc-note">Try IMDb's own search</a>.</div>` : ''}

        ${s.titles.length ? html`
          <section class="imdbc-sec">
            ${sectionHead('Titles', num(s.titles.length) + (s.moreTitles ? '+' : ''))}
            <div class="imdbc-results">${s.titles.map(searchTitleRow)}</div>
            ${(s.moreTitles && s.section !== 'tt') ? html`<div class="imdbc-more"><a class="imdbc-btn" href="${findUrl(s.query, 'tt')}">More titles</a></div>` : ''}
          </section>` : ''}

        ${s.names.length ? html`
          <section class="imdbc-sec">
            ${sectionHead('People', num(s.names.length))}
            <div class="imdbc-results">${s.names.map(searchNameRow)}</div>
            ${s.section !== 'nm' ? html`<div class="imdbc-more"><a class="imdbc-btn" href="${findUrl(s.query, 'nm')}">More people</a></div>` : ''}
          </section>` : ''}
      </div>`);

    wireTopBar(root);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12c. Title sub-pages: ratings, full credits, episodes, reviews
  // ══════════════════════════════════════════════════════════════════════════
  //
  // These all hang their data off `contentData` rather than the
  // aboveTheFold/mainColumn split the main title page uses, and they all share
  // `contentData.entityMetadata` for the title header.

  const SUB_PAGES = [
    { key: 'title', label: 'Overview', path: '' },
    { key: 'titleCredits', label: 'Cast & crew', path: 'fullcredits/' },
    { key: 'titleEpisodes', label: 'Episodes', path: 'episodes/', seriesOnly: true },
    { key: 'titleReviews', label: 'Reviews', path: 'reviews/' },
    { key: 'titleRatings', label: 'Ratings', path: 'ratings/' }
  ];

  /** IMDb pre-escapes some payload strings (episode plots carry `&#39;`). */
  function decodeEntities(str) {
    const s = String(str == null ? '' : str);
    if (s.indexOf('&') < 0) return s;
    const el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  }

  /** The compact title header these pages share. */
  function normaliseEntity(pp) {
    const e = (pp.contentData && pp.contentData.entityMetadata) || {};
    return {
      id: e.id,
      title: (e.titleText && e.titleText.text) || (pp.contentData && pp.contentData.titleText) || '',
      year: yearText(e.releaseYear),
      typeText: (e.titleType && e.titleType.text) || '',
      typeId: (e.titleType && e.titleType.id) || '',
      isSeries: !!(e.titleType && e.titleType.isSeries),
      runtime: runtimeText(e.runtime && e.runtime.seconds),
      certificate: (e.certificate && e.certificate.rating) || '',
      genres: ((e.titleGenres && e.titleGenres.genres) || []).map((g) => (g.genre && g.genre.text) || g.text).filter(Boolean),
      poster: (e.primaryImage && e.primaryImage.url) || '',
      posterSize: imgSize(e.primaryImage),
      rating: e.ratingsSummary && e.ratingsSummary.aggregateRating,
      votes: e.ratingsSummary && e.ratingsSummary.voteCount
    };
  }

  function subPageHeader(ent, activeKey) {
    const poster = thumb(ent.poster, 132, 198, ent.posterSize);
    const bits = [ent.year, ent.typeText && ent.typeText !== 'Movie' ? ent.typeText : '', ent.runtime, ent.certificate].filter(Boolean);
    const tabs = SUB_PAGES
      .filter((t) => !t.seriesOnly || ent.isSeries)
      .map((t) => html`<a class="imdbc-btn${t.key === activeKey ? ' is-on' : ''}" href="${titleUrl(ent.id) + t.path}">${t.label}</a>`);
    return html`
      <div class="imdbc-subhead">
        <a class="po" href="${titleUrl(ent.id)}" tabindex="-1" aria-hidden="true">
          ${poster ? html`<img src="${poster}" alt="" decoding="async">` : ''}
        </a>
        <div class="main">
          <h1 class="imdbc-h1"><a href="${titleUrl(ent.id)}">${ent.title}</a></h1>
          <div class="imdbc-sub">
            ${bits.length ? html`<span>${bits.join(' · ')}</span>` : ''}
            ${typeof ent.rating === 'number'
              ? html`<span class="rt ${ratingClasses(ent.rating, 10, ent.votes)}">★ ${ent.rating.toFixed(1)}</span>` : ''}
          </div>
          <div class="imdbc-tools imdbc-subtabs">${tabs}</div>
        </div>
      </div>`;
  }

  // ── ratings ───────────────────────────────────────────────────────────────

  function normaliseRatings(pp) {
    const h = (pp.contentData && pp.contentData.histogramData) || {};
    const rows = (h.histogramValues || [])
      .map((v) => ({ rating: Number(v.rating), votes: Number(v.voteCount) || 0, label: v.formattedVoteCount || '' }))
      .filter((v) => isFinite(v.rating))
      .sort((a, b) => b.rating - a.rating);
    return {
      rows,
      total: h.totalVoteCount || 0,
      average: h.aggregateRating,
      countries: (h.countryData || []).map((c) => ({
        name: c.displayText || c.countryCode || '',
        average: c.aggregateRating,
        votes: c.totalVoteCount || 0
      })).filter((c) => c.name)
    };
  }

  function renderTitleRatings(root, ent, r) {
    const peak = Math.max(1, ...r.rows.map((x) => x.votes));
    const bars = r.rows.map((x) => {
      const pct = r.total ? (x.votes / r.total) * 100 : 0;
      return html`
        <div class="imdbc-hrow">
          <span class="sc ${ratingBand(x.rating, 10)}">${x.rating}</span>
          <span class="bar"><span class="fill ${ratingBand(x.rating, 10)}" style="width:${(x.votes / peak * 100).toFixed(2)}%"></span></span>
          <span class="ct">${x.label || compactNum(x.votes)}</span>
          <span class="pc">${pct.toFixed(1)}%</span>
        </div>`;
    });

    root.innerHTML = interpolate(html`
      ${topBar(titleUrl(ent.id) + 'ratings/')}
      <div class="imdbc-wrap">
        ${subPageHeader(ent, 'titleRatings')}

        <section class="imdbc-sec">
          ${sectionHead('Rating breakdown',
            (typeof r.average === 'number' ? r.average.toFixed(1) + ' from ' : '') + num(r.total) + ' votes')}
          <div class="imdbc-histogram">${bars}</div>
        </section>

        ${r.countries.length ? html`
          <section class="imdbc-sec">
            ${sectionHead('By country', '')}
            <div class="imdbc-credits">
              ${r.countries.map((c) => html`
                <div class="imdbc-hcountry">
                  <span class="nm">${c.name}</span>
                  <span class="rt ${ratingBand(c.average, 10)}">${typeof c.average === 'number' ? c.average.toFixed(1) : '—'}</span>
                  <span class="ct">${compactNum(c.votes)} votes</span>
                </div>`)}
            </div>
          </section>` : ''}
      </div>`);
    wireTopBar(root);
  }

  // ── full cast & crew ──────────────────────────────────────────────────────

  function normaliseFullCredits(pp) {
    const cats = (pp.contentData && pp.contentData.categories) || [];
    return cats.map((c) => ({
      name: c.name || 'Other',
      total: (c.section && c.section.total) || (c.section && c.section.items ? c.section.items.length : 0),
      isCast: !!(c.section && c.section.items && c.section.items[0] && c.section.items[0].isCast),
      people: ((c.section && c.section.items) || []).map((it) => {
        const im = it.imageProps && it.imageProps.imageModel;
        return {
          id: it.id,
          name: decodeEntities(it.rowTitle || ''),
          characters: (it.characters || []).map((ch) => decodeEntities(ch)).filter(Boolean),
          attributes: it.attributes ? [decodeEntities(it.attributes)] : [],
          photo: (im && im.url) || '',
          photoSize: imgSize(im)
        };
      }).filter((p) => p.id && p.name)
    })).filter((c) => c.people.length);
  }

  function renderTitleCredits(root, ent, cats) {
    const castCat = cats.find((c) => c.isCast) || cats.find((c) => /^cast$/i.test(c.name));
    const rest = cats.filter((c) => c !== castCat);

    root.innerHTML = interpolate(html`
      ${topBar(titleUrl(ent.id) + 'fullcredits/')}
      <div class="imdbc-wrap">
        ${subPageHeader(ent, 'titleCredits')}

        ${castCat ? html`
          <section class="imdbc-sec">
            ${sectionHead('Cast', num(castCat.total), html`
              <input type="search" data-imdbc-cc-filter placeholder="Filter cast or character" aria-label="Filter cast">`)}
            <div class="imdbc-cast" data-imdbc-cc-grid>
              ${castCat.people.map((p) => personCard(p, { showEpisodes: false }))}
            </div>
          </section>` : ''}

        ${rest.map((c) => html`
          <section class="imdbc-sec">
            ${sectionHead(c.name, c.people.length > 1 ? num(c.total) : '')}
            <div class="imdbc-crewlist">
              ${c.people.map((p) => html`
                <div class="imdbc-crewrow">
                  <a class="nm" href="${nameUrl(p.id)}">${p.name}</a>
                  ${p.characters.length ? html`<span class="rl">${p.characters.join(' / ')}</span>` : ''}
                  ${p.attributes.length && p.attributes[0] ? html`<span class="at">${p.attributes.join(', ')}</span>` : ''}
                </div>`)}
            </div>
          </section>`)}
      </div>`);

    wireTopBar(root);

    const filter = root.querySelector('[data-imdbc-cc-filter]');
    const grid = root.querySelector('[data-imdbc-cc-grid]');
    if (filter && grid && castCat) {
      let timer = null;
      filter.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const q = filter.value.trim().toLowerCase();
          const list = q
            ? castCat.people.filter((p) => p.name.toLowerCase().includes(q)
              || p.characters.some((c) => c.toLowerCase().includes(q)))
            : castCat.people;
          grid.innerHTML = list.length
            ? list.map((p) => interpolate(personCard(p, { showEpisodes: false }))).join('')
            : interpolate(html`<div class="imdbc-empty">No cast member matches that.</div>`);
        }, 140);
      });
    }
  }

  // ── episodes ──────────────────────────────────────────────────────────────

  function normaliseEpisodes(pp) {
    const sec = (pp.contentData && pp.contentData.section) || {};
    const items = (sec.episodes && sec.episodes.items) || [];
    return {
      seasons: (sec.seasons || []).map((s) => String(s.value)).filter(Boolean),
      current: sec.currentSeason != null ? String(sec.currentSeason) : '',
      total: (sec.episodes && sec.episodes.total) || items.length,
      hasMore: !!(sec.episodes && sec.episodes.hasNextPage),
      episodes: items.map((e) => ({
        id: e.id,
        season: e.season,
        number: e.episode,
        title: decodeEntities(e.titleText || ''),
        plot: decodeEntities(e.plot || ''),
        date: imdbDateText(e.releaseDate) || (e.releaseYear ? String(e.releaseYear) : ''),
        still: (e.image && e.image.url) || '',
        stillSize: imgSize(e.image),
        rating: e.aggregateRating,
        votes: e.voteCount
      })).filter((e) => e.id)
    };
  }

  function renderTitleEpisodes(root, ent, ep) {
    const base = titleUrl(ent.id) + 'episodes/';
    const tabs = ep.seasons.map((s) => html`
      <a class="imdbc-btn${s === ep.current ? ' is-on' : ''}" href="${base + '?season=' + encodeURIComponent(s)}">Season ${s}</a>`);

    root.innerHTML = interpolate(html`
      ${topBar(base)}
      <div class="imdbc-wrap">
        ${subPageHeader(ent, 'titleEpisodes')}

        <section class="imdbc-sec">
          ${sectionHead(ep.current ? 'Season ' + ep.current : 'Episodes', num(ep.total) + ' episode' + (ep.total === 1 ? '' : 's'))}
          ${ep.seasons.length > 1 ? html`<div class="imdbc-tools" style="margin-bottom:18px">${tabs}</div>` : ''}
          <div class="imdbc-eplist">
            ${ep.episodes.length ? ep.episodes.map((e) => {
              const still = thumb(e.still, 240, 135, e.stillSize);
              return html`
                <a class="imdbc-ep" href="${titleUrl(e.id)}">
                  <span class="st">${still ? html`<img src="${still}" alt="" loading="lazy" decoding="async">` : ''}</span>
                  <span class="main">
                    <span class="ti"><span class="no">S${e.season}·E${e.number}</span> ${e.title}</span>
                    <span class="mt">
                      ${e.date ? html`<span>${e.date}</span>` : ''}
                      ${typeof e.rating === 'number'
                        ? html`<span class="rt ${ratingClasses(e.rating, 10, e.votes)}">★ ${e.rating.toFixed(1)}<small> ${compactNum(e.votes)}</small></span>` : ''}
                    </span>
                    ${e.plot ? html`<span class="pl">${e.plot}</span>` : ''}
                  </span>
                </a>`;
            }) : html`<div class="imdbc-empty">No episodes listed for this season.</div>`}
          </div>
          ${ep.hasMore ? html`<div class="imdbc-more"><span class="imdbc-note">IMDb paginates beyond this point. <a href="${base}">Open the full list on IMDb</a>.</span></div>` : ''}
        </section>
      </div>`);
    wireTopBar(root);
  }

  // ── reviews ───────────────────────────────────────────────────────────────

  function renderTitleReviews(root, ent, pp) {
    const total = (pp.contentData && pp.contentData.reviewCount) || 0;
    // The reviews list, its sorting and its pagination already exist for the
    // main title page; this page is the same component with a header on top.
    const stub = { id: ent.id, reviewTotal: total, featuredReviews: [] };

    root.innerHTML = interpolate(html`
      ${topBar(titleUrl(ent.id) + 'reviews/')}
      <div class="imdbc-wrap">
        ${subPageHeader(ent, 'titleReviews')}
        <section class="imdbc-sec" data-imdbc-reviews>
          ${sectionHead('User reviews', total ? num(total) : '', html`
            <select data-imdbc-review-sort aria-label="Sort reviews">
              ${Object.entries(REVIEW_SORTS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}
            </select>`)}
          <div class="imdbc-reviews" data-imdbc-review-list></div>
          <div class="imdbc-more" data-imdbc-review-more></div>
        </section>
      </div>`);

    wireTopBar(root);
    wireTitleReviews(root, stub);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12d. Charts, lists and advanced search
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Three pages, one shape: an ordered set of titles. Charts and lists carry
  // the ordinary Title node; advanced search carries the same flat listItem the
  // /find page uses, so both feed the one row renderer.

  const CHARTS = {
    top: 'IMDb Top 250',
    toptv: 'Top 250 TV shows',
    moviemeter: 'Most popular movies',
    tvmeter: 'Most popular TV shows',
    boxoffice: 'Top box office',
    'top-english-movies': 'Top English-language movies'
  };

  /** The flat listItem shape shared by /find and /search/title. */
  function normaliseFlatTitle(li) {
    if (!li) return null;
    const start = li.releaseYear;
    const end = li.endYear;
    return {
      id: li.titleId,
      title: li.titleText || li.originalTitleText || '',
      year: start ? (end && end !== start ? `${start}–${end}` : String(start)) : '',
      startYear: start,
      typeText: (li.titleType && li.titleType.text) || '',
      certificate: li.certificate || '',
      genres: Array.isArray(li.genres) ? li.genres : [],
      plot: li.plot || '',
      poster: (li.primaryImage && li.primaryImage.url) || '',
      posterSize: imgSize(li.primaryImage),
      rating: li.ratingSummary && li.ratingSummary.aggregateRating,
      votes: li.ratingSummary && li.ratingSummary.voteCount,
      runtime: runtimeText(li.runtime && (li.runtime.seconds || li.runtime))
    };
  }

  function normaliseTitleListPage(pp, route) {
    if (route.kind === 'chart') {
      const edges = (pp.pageData && pp.pageData.chartTitles && pp.pageData.chartTitles.edges) || [];
      return {
        heading: CHARTS[route.id] || 'Chart',
        subtitle: '',
        items: edges.map((e) => {
          const t = normaliseTitleCard(e && e.node);
          if (t) t.rank = e.currentRank;
          return t;
        }).filter(Boolean),
        ranked: true
      };
    }

    if (route.kind === 'list') {
      const list = (pp.mainColumnData && pp.mainColumnData.list) || {};
      const edges = (list.titleListItemSearch && list.titleListItemSearch.edges) || [];
      const author = (pp.aboveTheFoldData && pp.aboveTheFoldData.authorName)
        || (list.author && list.author.nickName) || '';
      return {
        heading: (list.name && list.name.originalText) || 'List',
        subtitle: [(list.description && list.description.originalText && list.description.originalText.plainText) || '',
          author ? 'by ' + author : ''].filter(Boolean).join(' · '),
        total: (list.titleListItemSearch && list.titleListItemSearch.total) || pp.totalItems,
        items: edges.map((e) => normaliseTitleCard(e && (e.node || e.listItem))).filter(Boolean),
        ranked: false
      };
    }

    // advanced search
    const tr = (pp.searchResults && pp.searchResults.titleResults) || {};
    return {
      heading: 'Search results',
      subtitle: '',
      total: tr.total,
      items: (tr.titleListItems || []).map(normaliseFlatTitle).filter((t) => t && t.id),
      ranked: false
    };
  }

  function renderTitleList(root, data, imdbHref) {
    const count = data.total ? num(data.total) : num(data.items.length);
    root.innerHTML = interpolate(html`
      ${topBar(imdbHref)}
      <div class="imdbc-wrap">
        <div class="imdbc-search-head">
          <h1 class="imdbc-h1">${data.heading}</h1>
        </div>
        ${data.subtitle ? html`<p class="imdbc-plot">${data.subtitle}</p>` : ''}
        <section class="imdbc-sec">
          ${sectionHead('Titles', count + (data.total && data.total > data.items.length ? ` · showing ${num(data.items.length)}` : ''))}
          <div class="imdbc-results">
            ${data.items.length
              ? data.items.map((t) => html`
                <a class="imdbc-result${data.ranked ? ' ranked' : ''}" href="${titleUrl(t.id)}">
                  ${data.ranked ? html`<span class="rank">${t.rank || ''}</span>` : ''}
                  <span class="po">${thumb(t.poster, 96, 144, t.posterSize)
                    ? html`<img src="${thumb(t.poster, 96, 144, t.posterSize)}" alt="" loading="lazy" decoding="async">` : ''}</span>
                  <span class="main">
                    <span class="ti">${t.title}</span>
                    <span class="mt">
                      ${[t.year, t.typeText && t.typeText !== 'Movie' ? t.typeText : '', t.runtime, t.certificate].filter(Boolean).length
                        ? html`<span>${[t.year, t.typeText && t.typeText !== 'Movie' ? t.typeText : '', t.runtime, t.certificate].filter(Boolean).join(' · ')}</span>` : ''}
                      ${typeof t.rating === 'number'
                        ? html`<span class="rt ${ratingClasses(t.rating, 10, t.votes)}">★ ${t.rating.toFixed(1)}<small> ${compactNum(t.votes)}</small></span>` : ''}
                      ${t.genres && t.genres.length ? html`<span>${t.genres.slice(0, 3).join(', ')}</span>` : ''}
                    </span>
                    ${t.plot ? html`<span class="pl">${t.plot}</span>` : ''}
                  </span>
                </a>`)
              : html`<div class="imdbc-empty">Nothing here. <a href="${safeUrl(imdbHref)}" class="imdbc-note">Open it on IMDb</a>.</div>`}
          </div>
          ${data.total && data.total > data.items.length ? html`
            <div class="imdbc-more">
              <span class="imdbc-note">IMDb pages the rest. <a href="${safeUrl(imdbHref)}">Continue on IMDb</a>.</span>
            </div>` : ''}
        </section>
      </div>`);
    wireTopBar(root);
  }

  function listPageUrl(route) {
    if (route.kind === 'chart') return 'https://www.imdb.com/chart/' + encodeURIComponent(route.id) + '/';
    if (route.kind === 'list') return 'https://www.imdb.com/list/' + encodeURIComponent(route.id) + '/';
    return 'https://www.imdb.com/search/title/' + (route.query || '');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12e. Trailers and photos
  // ══════════════════════════════════════════════════════════════════════════

  // Quality order for the <video> source. The AUTO entry is an HLS master
  // playlist, which Chrome will not play natively, so it is never chosen.
  const VIDEO_QUALITY = ['720p', '1080p', '480p', 'SD'];

  function normaliseVideo(node) {
    if (!node || !node.id) return null;
    const sources = (node.playbackURLs || [])
      .map((p) => ({
        url: (p && p.url) || '',
        quality: (p && p.displayName && p.displayName.value) || '',
        mime: (p && p.mimeType) || ''
      }))
      .filter((p) => p.url && !/\.m3u8|hls-/i.test(p.url));
    return {
      id: node.id,
      name: (node.name && node.name.value) || 'Video',
      seconds: (node.runtime && node.runtime.value) || 0,
      type: (node.contentType && node.contentType.displayName && node.contentType.displayName.value) || '',
      thumb: (node.thumbnail && node.thumbnail.url) || '',
      thumbSize: imgSize(node.thumbnail),
      sources
    };
  }

  /** Highest quality we can actually play, in a deliberate order. */
  function bestSource(video) {
    if (!video || !video.sources.length) return '';
    for (const want of VIDEO_QUALITY) {
      const hit = video.sources.find((s) => s.quality === want);
      if (hit) return hit.url;
    }
    return video.sources[0].url;
  }

  function normaliseImages(conn) {
    return edges(conn).map((n) => ({
      id: n.id,
      url: n.url,
      width: n.width,
      height: n.height,
      caption: (n.caption && (n.caption.plainText || n.caption)) || ''
    })).filter((i) => i.url);
  }

  const videoTime = (s) => (s ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '');

  /**
   * Playback URLs are signed and carry an Expires stamp, so they are held in
   * memory for the life of the page and never written to disk.
   */
  function fetchVideo(videoId) {
    return memoize('video:' + videoId, 20 * 60 * 1000, async () => {
      const data = await gql(`{ video(id: ${gqlStr(videoId)}) {
        id name { value } runtime { value } contentType { displayName { value } }
        thumbnail { url width height }
        playbackURLs { url displayName { value } mimeType }
      } }`);
      return normaliseVideo(data && data.video);
    });
  }

  function fetchImages(kind, id, count) {
    const field = kind === 'name' ? 'name' : 'title';
    return memoizeDisk(`images:${id}:${count}`, 6 * 3600 * 1000, async () => {
      const data = await gql(`{ ${field}(id: ${gqlStr(id)}) {
        images(first: ${Math.max(1, Math.min(250, count))}) {
          total edges { node { id url width height caption { plainText } } }
        }
      } }`);
      const conn = data && data[field] && data[field].images;
      return { total: (conn && conn.total) || 0, images: normaliseImages(conn) };
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function videoSection(m) {
    if (!settings.trailers || !(m.trailer || (m.videos && m.videos.length))) return '';
    return interpolate(html`
        <section class="imdbc-sec" data-imdbc-videos>
          ${sectionHead(m.trailer && /trailer/i.test(m.trailer.type) ? 'Trailer' : 'Video',
            m.videoTotal ? num(m.videoTotal) : '')}
          <div class="imdbc-player" data-imdbc-player>${raw(playerHtml(m.trailer))}</div>
          ${m.videos && m.videos.length > 1 ? html`
            <div class="imdbc-vstrip" data-imdbc-vstrip>
              ${m.videos.map((v) => html`
                <button type="button" class="imdbc-vthumb${m.trailer && v.id === m.trailer.id ? ' is-on' : ''}" data-imdbc-video="${v.id}">
                  <span class="th">${thumb(v.thumb, 240, 135, v.thumbSize)
                    ? html`<img src="${thumb(v.thumb, 240, 135, v.thumbSize)}" alt="" loading="lazy" decoding="async">` : ''}
                    ${v.seconds ? html`<span class="dur">${videoTime(v.seconds)}</span>` : ''}</span>
                  <span class="nm">${v.name}</span>
                </button>`)}
            </div>` : ''}
        </section>`);
  }

  function photoSection(m) {
    if (!settings.photos || !(m.images && m.images.length)) return '';
    return interpolate(html`
        <section class="imdbc-sec" data-imdbc-photos>
          ${sectionHead('Photos', m.imageTotal ? num(m.imageTotal) : num(m.images.length))}
          <div class="imdbc-photogrid" data-imdbc-photogrid>${raw(photoCells(m.images))}</div>
          <div class="imdbc-more" data-imdbc-photos-more>
            ${m.imageTotal > m.images.length
              ? html`<button type="button" class="imdbc-btn" data-imdbc-photos-all>Show more photos</button>` : ''}
          </div>
        </section>`);
  }

  function photoCells(images) {
    return images.map((img, i) => interpolate(html`
      <button type="button" class="imdbc-photo" data-imdbc-photo="${i}" aria-label="${img.caption || 'Photo'}">
        <img src="${thumb(img.url, 320, 214, img)}" alt="${img.caption}" loading="lazy" decoding="async">
      </button>`)).join('');
  }

  function playerHtml(video) {
    if (!video) return '';
    const poster = thumb(video.thumb, 960, 540, video.thumbSize);
    const src = bestSource(video);
    if (!src) {
      // No playable source: link out rather than show a dead play button.
      return interpolate(html`
        <a class="imdbc-vhero" href="https://www.imdb.com/video/${encodeURIComponent(video.id)}/" target="_blank" rel="noopener noreferrer">
          ${poster ? html`<img src="${poster}" alt="">` : ''}
          <span class="play" aria-hidden="true"></span>
          <span class="meta"><b>${video.name}</b>${video.seconds ? html` · ${videoTime(video.seconds)}` : ''} · watch on IMDb</span>
        </a>`);
    }
    return interpolate(html`
      <button type="button" class="imdbc-vhero" data-imdbc-play="${video.id}">
        ${poster ? html`<img src="${poster}" alt="">` : ''}
        <span class="play" aria-hidden="true"></span>
        <span class="meta"><b>${video.name}</b>${video.type ? html` · ${video.type}` : ''}${video.seconds ? html` · ${videoTime(video.seconds)}` : ''}</span>
      </button>`);
  }

  function playInline(host, video) {
    const src = bestSource(video);
    if (!src) return;
    host.innerHTML = interpolate(html`
      <video class="imdbc-video" controls autoplay playsinline preload="metadata"
             poster="${thumb(video.thumb, 960, 540, video.thumbSize)}" src="${safeUrl(src)}"></video>
      <div class="imdbc-vcaption">${video.name}${video.seconds ? html` · ${videoTime(video.seconds)}` : ''}</div>`);
  }

  function wireMedia(root, m) {
    const token = renderSeq;
    const fresh = () => token === renderSeq && root.isConnected;

    // ── videos ──
    const videoSec = root.querySelector('[data-imdbc-videos]');
    if (videoSec) {
      const player = videoSec.querySelector('[data-imdbc-player]');
      videoSec.addEventListener('click', async (e) => {
        const play = e.target.closest('[data-imdbc-play]');
        if (play && m.trailer) { playInline(player, m.trailer); return; }

        const pick = e.target.closest('[data-imdbc-video]');
        if (!pick) return;
        const id = pick.getAttribute('data-imdbc-video');
        for (const b of videoSec.querySelectorAll('[data-imdbc-video]')) b.classList.toggle('is-on', b === pick);
        if (m.trailer && id === m.trailer.id) { playInline(player, m.trailer); return; }
        player.innerHTML = interpolate(html`<div class="imdbc-vhero is-loading"><span class="imdbc-loading">loading video</span></div>`);
        try {
          const v = await fetchVideo(id);
          if (!fresh()) return;
          if (v && bestSource(v)) playInline(player, v);
          else player.innerHTML = playerHtml(v || m.trailer);
        } catch (err) {
          warn('video fetch failed', err);
          if (!fresh()) return;
          player.innerHTML = interpolate(html`<div class="imdbc-vhero is-loading"><span class="imdbc-note">That video could not be loaded. <a href="https://www.imdb.com/video/${encodeURIComponent(id)}/">Watch it on IMDb</a>.</span></div>`);
        }
      });
    }

    // ── photos ──
    const photoSec = root.querySelector('[data-imdbc-photos]');
    if (!photoSec) return;
    const grid = photoSec.querySelector('[data-imdbc-photogrid]');
    const more = photoSec.querySelector('[data-imdbc-photos-more]');
    let images = m.images.slice();

    photoSec.addEventListener('click', async (e) => {
      const cell = e.target.closest('[data-imdbc-photo]');
      if (cell) { openLightbox(images, Number(cell.getAttribute('data-imdbc-photo')) || 0); return; }

      if (!e.target.closest('[data-imdbc-photos-all]')) return;
      more.innerHTML = interpolate(html`<span class="imdbc-loading">loading photos</span>`);
      try {
        const got = await fetchImages(m.kind, m.id, 120);
        if (!fresh()) return;
        if (got && got.images.length) {
          images = got.images;
          grid.innerHTML = photoCells(images);
        }
        more.innerHTML = (got && got.total > images.length)
          ? interpolate(html`<a class="imdbc-btn" href="${(m.kind === 'name' ? nameUrl(m.id) : titleUrl(m.id)) + 'mediaindex/'}">All ${num(got.total)} on IMDb</a>`)
          : '';
      } catch (err) {
        warn('photo fetch failed', err);
        if (!fresh()) return;
        more.innerHTML = interpolate(html`<span class="imdbc-note">More photos could not be loaded.</span>`);
      }
    });
  }

  // ── lightbox ──────────────────────────────────────────────────────────────

  function openLightbox(images, start) {
    closeLightbox();
    let i = Math.max(0, Math.min(start, images.length - 1));

    const box = document.createElement('div');
    box.className = 'imdbc-lightbox';
    box.id = 'imdbc-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Photo viewer');

    const paint = () => {
      const img = images[i];
      box.innerHTML = interpolate(html`
        <button type="button" class="nav prev" data-lb="-1" aria-label="Previous photo">‹</button>
        <figure>
          <img src="${thumb(img.url, 1400, 0, img)}" alt="${img.caption}">
          <figcaption>${img.caption ? html`${img.caption}` : ''}<span class="of">${i + 1} / ${images.length}</span></figcaption>
        </figure>
        <button type="button" class="nav next" data-lb="1" aria-label="Next photo">›</button>
        <button type="button" class="close" data-lb-close aria-label="Close">×</button>`);
    };
    const step = (d) => { i = (i + d + images.length) % images.length; paint(); };

    box.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-lb]');
      if (nav) { step(Number(nav.getAttribute('data-lb'))); return; }
      // Clicking the backdrop closes; clicking the photo itself does not.
      if (e.target.closest('[data-lb-close]') || !e.target.closest('figure')) closeLightbox();
    });

    box.__keys = (e) => {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    document.addEventListener('keydown', box.__keys);

    paint();
    document.body.appendChild(box);
    box.focus();
  }

  function closeLightbox() {
    const box = document.getElementById('imdbc-lightbox');
    if (!box) return;
    if (box.__keys) document.removeEventListener('keydown', box.__keys);
    box.remove();
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
  }

  function personCard(p, { showEpisodes = true } = {}) {
    const chars = p.characters && p.characters.length ? p.characters.join(' / ') : '';
    const attrs = p.attributes && p.attributes.length ? p.attributes.join(', ') : '';
    const eps = showEpisodes && p.episodeCount
      ? `${num(p.episodeCount)} episode${p.episodeCount === 1 ? '' : 's'}${p.episodeYears ? ' · ' + p.episodeYears : ''}`
      : '';
    const photo = thumb(p.photo, 180, 270, p.photoSize);
    return html`
      <div class="imdbc-person">
        <a class="ph" href="${nameUrl(p.id)}" tabindex="-1" aria-hidden="true">
          ${photo ? html`<img src="${photo}" alt="" loading="lazy" decoding="async">` : initials(p.name)}
        </a>
        <div>
          <div class="nm"><a href="${nameUrl(p.id)}">${p.name}</a></div>
          ${chars ? html`<div class="ch">${chars}</div>` : ''}
          ${attrs ? html`<div class="attr">${attrs}</div>` : ''}
          ${eps ? html`<div class="ep">${eps}</div>` : ''}
        </div>
      </div>`;
  }

  function titleCard(t) {
    const poster = thumb(t.poster, 180, 270, t.posterSize);
    const bits = [t.year, t.typeText && t.typeText !== 'Movie' ? t.typeText : ''].filter(Boolean);
    return html`
      <div class="imdbc-card">
        <a class="po" href="${titleUrl(t.id)}" tabindex="-1" aria-hidden="true">
          ${poster ? html`<img src="${poster}" alt="" loading="lazy" decoding="async">` : ''}
        </a>
        <div>
          <div class="ti"><a href="${titleUrl(t.id)}">${t.title}</a></div>
          <div class="mt">
            ${bits.length ? html`<span>${bits.join(' · ')}</span>` : ''}
            ${typeof t.rating === 'number' ? html`<span class="rt ${ratingClasses(t.rating, 10, t.votes)}">★ ${t.rating.toFixed(1)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }

  function sectionHead(title, count, toolsHtml) {
    return html`
      <div class="imdbc-sec-head">
        <h2>${title}</h2>
        ${count !== null && count !== undefined && count !== '' ? html`<span class="count">${count}</span>` : ''}
        <span class="spacer"></span>
        ${toolsHtml ? html`<div class="imdbc-tools">${toolsHtml}</div>` : ''}
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12. Title page
  // ══════════════════════════════════════════════════════════════════════════

  function renderTitle(root, t) {
    const heroPoster = thumb(t.poster, 400, 600, t.posterSize);

    const metaBits = [];
    if (t.year) metaBits.push(esc(t.year));
    if (t.typeText && t.typeText !== 'Movie') metaBits.push(esc(t.typeText));
    if (t.runtime) metaBits.push(esc(t.runtime));
    if (t.certificate) metaBits.push(esc(t.certificate));
    if (t.productionStage && t.productionStage !== 'Released') metaBits.push(esc(t.productionStage));

    const crewLines = t.principals.map((g) => html`
      <div><span class="k">${g.label}</span>
        ${raw(g.people.map((p) => `<a href="${esc(nameUrl(p.id))}">${esc(p.name)}</a>`).join(', '))}</div>`);

    let episodeLine = '';
    if (t.parentSeries) {
      const en = t.episodeNumber;
      episodeLine = html`<div class="imdbc-crew"><div><span class="k">Episode of</span>
        <a href="${titleUrl(t.parentSeries.id)}">${t.parentSeries.title}</a>${en && en.season
          ? html` <span class="imdbc-note">(S${en.season}${en.episode ? '·E' + en.episode : ''})</span>` : ''}</div></div>`;
    }

    root.innerHTML = interpolate(html`
      ${topBar(titleUrl(t.id))}
      <div class="imdbc-wrap">
        <div class="imdbc-hero">
          <div>
            <div class="imdbc-hero-poster">
              ${heroPoster ? html`<img src="${heroPoster}" alt="Poster for ${t.title}" decoding="async">` : ''}
            </div>
          </div>
          <div>
            <h1 class="imdbc-h1">${t.title}</h1>
            <div class="imdbc-sub">${raw(metaBits.join('<span class="dot">·</span>'))}</div>
            ${t.originalTitle && t.originalTitle !== t.title
              ? html`<div class="imdbc-orig">Original title: ${t.originalTitle}</div>` : ''}
            ${episodeLine}
            ${t.genres.length ? html`<div class="imdbc-chips">${t.genres.map((g) => html`<span class="imdbc-chip">${g}</span>`)}</div>` : ''}
            ${t.plot ? html`<p class="imdbc-plot">${t.plot}</p>` : ''}
            <div class="imdbc-scores" data-imdbc-scores>${raw(scoreStrip(t))}</div>
            <div class="imdbc-actions" data-imdbc-actions>${raw(actionsHtml(t))}</div>
            ${crewLines.length ? html`<div class="imdbc-crew">${crewLines}</div>` : ''}
          </div>
        </div>

        ${raw(videoSection(t))}

        ${t.episodes ? html`
          <section class="imdbc-sec" data-imdbc-seasons>
            ${sectionHead('Seasons & episodes',
              `${num(t.episodes.seasonCount)} season${t.episodes.seasonCount === 1 ? '' : 's'} · ${num(t.episodes.total)} episode${t.episodes.total === 1 ? '' : 's'}${t.episodes.isOngoing ? ' · ongoing' : ''}`)}
            <div class="imdbc-seasons" data-imdbc-season-list>
              <span class="imdbc-loading">Counting episodes per season…</span>
            </div>
          </section>` : ''}

        <section class="imdbc-sec" data-imdbc-cast>
          ${sectionHead('Cast', t.castTotal ? num(t.castTotal) : '', html`
            <input type="search" data-imdbc-cast-filter placeholder="Filter cast or character" aria-label="Filter cast">`)}
          <div class="imdbc-cast" data-imdbc-cast-grid></div>
          <div class="imdbc-more" data-imdbc-cast-more></div>
        </section>

        <section class="imdbc-sec" data-imdbc-reviews>
          ${sectionHead('User reviews', t.reviewTotal ? num(t.reviewTotal) : '', html`
            <select data-imdbc-review-sort aria-label="Sort reviews">
              ${Object.entries(REVIEW_SORTS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}
            </select>`)}
          <div class="imdbc-reviews" data-imdbc-review-list></div>
          <div class="imdbc-more" data-imdbc-review-more></div>
        </section>

        ${t.moreLikeThis.length ? html`
          <section class="imdbc-sec">
            ${sectionHead('More like this', '')}
            <div class="imdbc-cards">${t.moreLikeThis.map(titleCard)}</div>
          </section>` : ''}

        ${raw(photoSection(t))}

        ${(t.countries.length || t.languages.length) ? html`
          <section class="imdbc-sec">
            ${sectionHead('Details', '')}
            <div class="imdbc-crew">
              ${t.countries.length ? html`<div><span class="k">Country</span> ${t.countries.join(', ')}</div>` : ''}
              ${t.languages.length ? html`<div><span class="k">Language</span> ${t.languages.join(', ')}</div>` : ''}
              ${t.watchlisted ? html`<div><span class="k">Watchlist</span> ${t.watchlisted}</div>` : ''}
            </div>
          </section>` : ''}
      </div>`);

    wireTopBar(root);
    wireExternalLinks(root, t);
    wireMedia(root, t);
    wireTitleCast(root, t);
    wireTitleReviews(root, t);
    if (t.episodes) wireSeasons(root, t);
    if (settings.rottenTomatoes) wireRottenTomatoes(root, t);
  }

  // Small brand marks, so a glance tells you whose score you are reading.
  const MARKS = {
    imdb: '<span class="mk mk-imdb">IMDb</span>',
    metacritic: '<span class="mk mk-mc" aria-hidden="true">m</span>',
    tomato: '<svg class="mk mk-svg" viewBox="0 0 16 16" aria-hidden="true">'
      + '<circle cx="8" cy="9.6" r="5.9" fill="#FA320A"/>'
      + '<path d="M7.6 1.4h.9v3h-.9z" fill="#3F8F3F"/>'
      + '<path d="M8 4.4C6.7 2.7 4.8 2.3 3.6 2.8 4 4.3 5.6 5 8 4.9zm0 0c1.3-1.7 3.2-2.1 4.4-1.6-.4 1.5-2 2.2-4.4 2.1z" fill="#4CA24C"/></svg>',
    splat: '<svg class="mk mk-svg" viewBox="0 0 16 16" aria-hidden="true">'
      + '<path d="M8 1.2l1.7 2.2 2.7-.6-.4 2.7 2.4 1.4-2 2 1 2.6-2.8.2-.9 2.6L8 12.7l-2.3 1.6-.9-2.6-2.8-.2 1-2.6-2-2 2.4-1.4-.4-2.7 2.7.6z" fill="#00B04B"/></svg>',
    popcorn: '<svg class="mk mk-svg" viewBox="0 0 16 16" aria-hidden="true">'
      + '<circle cx="5.3" cy="4.2" r="2.1" fill="#F7E2BE"/><circle cx="8.4" cy="3.1" r="2.2" fill="#FBEFD6"/>'
      + '<circle cx="11" cy="4.5" r="1.9" fill="#F7E2BE"/>'
      + '<path d="M3.1 6.2h9.8l-1.3 8.4H4.4z" fill="#E03C31"/>'
      + '<path d="M6.3 6.2h1.3l.4 8.4H6.8zm3.3 0h1.3l-.6 8.4H9.4z" fill="#fff" opacity=".9"/></svg>',
    trakt: '<svg class="mk mk-svg" viewBox="0 0 16 16" aria-hidden="true">'
      + '<circle cx="8" cy="8" r="7.3" fill="#ED1C24"/>'
      + '<path d="M3.6 11.2 8.9 5.9l.9.9-5.3 5.3zm2.2 1.6 4.3-4.3.9.9-4.3 4.3z" fill="#fff" opacity=".95"/>'
      + '<path d="M2.9 8.6 7.6 3.9l.9.9-4.7 4.7z" fill="#fff" opacity=".6"/></svg>',
    letterboxd: '<svg class="mk mk-svg mk-lbx" viewBox="0 0 30 12" aria-hidden="true">'
      + '<circle cx="6" cy="6" r="5.4" fill="#00E054"/><circle cx="15" cy="6" r="5.4" fill="#40BCF4"/>'
      + '<circle cx="24" cy="6" r="5.4" fill="#FF8000"/></svg>'
  };

  function scoreTile({ site, mark, name, value, unit, sub, href, extraClass, band }) {
    const inner = html`
      <span class="site">${raw(mark)}${name ? html`<span class="nm">${name}</span>` : ''}</span>
      <span class="val">${value}${unit ? html`<small>${unit}</small>` : ''}</span>
      <span class="sub">${sub || raw('&nbsp;')}</span>`;
    const cls = 'imdbc-score' + (extraClass ? ' ' + extraClass : '') + (band ? ' ' + band : '');
    return href
      ? interpolate(html`<a class="${cls}" data-site="${site}" href="${safeUrl(href)}" rel="noreferrer">${inner}</a>`)
      : interpolate(html`<div class="${cls}" data-site="${site}">${inner}</div>`);
  }

  function pendingTile(site, mark, name) {
    return interpolate(html`
      <div class="imdbc-score is-pending" data-site="${site}">
        <span class="site">${raw(mark)}<span class="nm">${name}</span></span>
        <span class="val"><span class="imdbc-loading"></span></span>
        <span class="sub">${raw('&nbsp;')}</span>
      </div>`);
  }

  /**
   * Reads t.rt and t.lbx, which are undefined while a lookup is in flight and
   * null once it has come back empty. Both handlers repaint through here, so
   * neither can clobber the other's tile.
   */
  function scoreStrip(t) {
    const parts = [];

    if (typeof t.rating === 'number') {
      parts.push(scoreTile({
        site: 'imdb', mark: MARKS.imdb, name: '',
        value: t.rating.toFixed(1), unit: '/10', band: ratingBand(t.rating, 10),
        sub: compactNum(t.votes) + ' votes' + (t.topRank ? ` · #${t.topRank} of all time` : ''),
        href: titleUrl(t.id) + 'ratings/'
      }));
    }

    if (typeof t.metascore === 'number') {
      parts.push(scoreTile({
        site: 'metacritic', mark: MARKS.metacritic, name: 'Metacritic',
        value: t.metascore, sub: 'critics', band: ratingBand(t.metascore, 100)
      }));
    }

    if (settings.rottenTomatoes) {
      if (t.rt === undefined) {
        parts.push(pendingTile('tomato', MARKS.tomato, 'Rotten Tomatoes'));
      } else if (t.rt && t.rt.critics) {
        const fresh = t.rt.critics.score >= 60;
        parts.push(scoreTile({
          site: 'tomato', mark: fresh ? MARKS.tomato : MARKS.splat,
          name: t.rt.critics.certified ? 'Certified Fresh' : 'Tomatometer',
          value: t.rt.critics.score, unit: '%',
          sub: t.rt.critics.count ? num(t.rt.critics.count) + ' critics' : 'critics',
          href: t.rt.url, band: ratingBand(t.rt.critics.score, 100)
        }));
      }
      if (t.rt && t.rt.audience) {
        parts.push(scoreTile({
          site: 'popcorn', mark: MARKS.popcorn, name: 'Popcornmeter',
          value: t.rt.audience.score, unit: '%',
          sub: t.rt.audience.banded || (t.rt.audience.count ? num(t.rt.audience.count) + ' ratings' : 'audience'),
          href: t.rt.url, band: ratingBand(t.rt.audience.score, 100)
        }));
      }
    }

    if (LETTERBOXD_TYPES.test(t.typeId)) {
      if (t.lbx === undefined) {
        parts.push(pendingTile('letterboxd', MARKS.letterboxd, 'Letterboxd'));
      } else if (t.lbx && typeof t.lbx.rating === 'number') {
        parts.push(scoreTile({
          site: 'letterboxd', mark: MARKS.letterboxd, name: 'Letterboxd',
          value: t.lbx.rating.toFixed(1), unit: '/' + (t.lbx.best || 5),
          sub: t.lbx.count ? compactNum(t.lbx.count) + ' ratings' : 'members',
          href: t.lbx.url, band: ratingBand(t.lbx.rating, t.lbx.best || 5)
        }));
      }
    }

    return parts.join('');
  }

  function repaintScores(root, t) {
    const host = root.querySelector('[data-imdbc-scores]');
    if (host) host.innerHTML = scoreStrip(t);
  }

  async function wireRottenTomatoes(root, t) {
    const token = renderSeq;
    if (!settings.rottenTomatoes) { t.rt = null; return; }
    // An episode has no Rotten Tomatoes page of its own; its series does.
    const target = (t.typeId === 'tvEpisode' && t.parentSeries)
      ? { id: t.parentSeries.id, title: t.parentSeries.title, year: null, isSeries: true }
      : { id: t.id, title: t.title, year: t.startYear, isSeries: t.isSeries };

    if (RT_UNSUPPORTED_TYPES.test(t.typeId) && !(t.typeId === 'tvEpisode' && t.parentSeries)) {
      t.rt = null;
      repaintScores(root, t);
      return;
    }


    let rt = null;
    try {
      rt = await lookupRottenTomatoes({
        imdbId: target.id,
        title: target.title,
        year: target.year,
        isSeries: target.isSeries,
        cast: t.cast.slice(0, 6).map((c) => c.name)
      });
    } catch (e) {
      warn('RT lookup threw', e);
    }
    // renderSeq moves on every render, so this also catches the case where the
    // root element survived but its contents were replaced by a later page.
    if (token !== renderSeq || !root.isConnected) return;
    t.rt = rt || null;
    repaintScores(root, t);
  }

  const CAST_PREVIEW = 24;

  function wireTitleCast(root, t) {
    const grid = root.querySelector('[data-imdbc-cast-grid]');
    const more = root.querySelector('[data-imdbc-cast-more]');
    const filterInput = root.querySelector('[data-imdbc-cast-filter]');
    if (!grid) return;

    const state = { all: t.cast.slice(), complete: t.cast.length >= (t.castTotal || 0), expanded: false, filter: '', error: false };

    function matching() {
      if (!state.filter) return state.all;
      const q = state.filter.toLowerCase();
      return state.all.filter((p) => p.name.toLowerCase().includes(q)
        || p.characters.some((c) => c.toLowerCase().includes(q)));
    }

    function paint() {
      const list = matching();
      if (!list.length) {
        grid.innerHTML = '';
        more.innerHTML = interpolate(html`<span class="imdbc-empty">No cast member matches that.</span>`);
        return;
      }
      const shown = (state.expanded || state.filter) ? list : list.slice(0, CAST_PREVIEW);
      grid.innerHTML = shown.map((p) => interpolate(personCard(p, { showEpisodes: t.isSeries }))).join('');

      const hidden = list.length - shown.length;
      const bits = [];
      if (hidden > 0) bits.push(`<button type="button" class="imdbc-btn" data-imdbc-cast-expand>Show all ${esc(num(list.length))} cast members</button>`);
      else if (state.expanded && !state.filter && list.length > CAST_PREVIEW) bits.push('<button type="button" class="imdbc-btn" data-imdbc-cast-collapse>Show fewer</button>');
      if (!state.complete) bits.push('<span class="imdbc-loading">loading the rest of the cast</span>');
      else if (state.error) {
        bits.push(`<span class="imdbc-note">Showing the ${esc(num(state.all.length))} cast members IMDb ships with the page. <a href="${esc(titleUrl(t.id) + 'fullcredits/')}">Full cast on IMDb</a>.</span>`);
      }
      more.innerHTML = bits.join('');
    }

    more.addEventListener('click', (e) => {
      if (e.target.closest('[data-imdbc-cast-expand]')) { state.expanded = true; paint(); }
      else if (e.target.closest('[data-imdbc-cast-collapse]')) { state.expanded = false; paint(); grid.scrollIntoView({ block: 'nearest' }); }
    });

    if (filterInput) {
      let timer = null;
      filterInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.filter = filterInput.value.trim(); paint(); }, 140);
      });
    }

    paint();

    if (settings.fullCast && !state.complete && t.castTotal > t.cast.length) {
      memoizeDisk('cast:' + t.id, 6 * 3600 * 1000, () => fetchFullCast(t.id))
        .then((full) => {
          if (!root.isConnected || !full.length) return;
          const seen = new Set();
          state.all = full.concat(state.all).filter((p) => {
            const key = p.id + '|' + p.characters.join('/');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          state.complete = true;
          paint();
        })
        .catch((e) => {
          warn('full cast fetch failed', e);
          if (!root.isConnected) return;
          state.complete = true;
          state.error = true;
          paint();
        });
    } else {
      state.complete = true;
    }
  }

  function reviewCard(r) {
    const score = typeof r.rating === 'number'
      ? html`<span class="imdbc-rv-rating ${ratingBand(r.rating, 10)}">${r.rating}/10</span>` : '';
    const href = r.id ? `https://www.imdb.com/review/${encodeURIComponent(r.id)}/` : '';
    return html`
      <article class="imdbc-review">
        <div class="imdbc-review-top">
          ${score}
          <div class="imdbc-rv-sum">${r.summary || 'Review'}</div>
        </div>
        <div class="imdbc-rv-meta">
          ${r.authorId ? html`<a href="https://www.imdb.com/user/${encodeURIComponent(r.authorId)}/">${r.author}</a>` : r.author}
          ${r.date ? html` · ${reviewDateText(r.date)}` : ''}
          ${r.spoiler ? html` · <span class="imdbc-spoiler-tag">spoiler — click to reveal</span>` : ''}
        </div>
        <div class="imdbc-rv-body clamped${r.spoiler ? ' spoiler' : ''}" data-imdbc-rv-body>${r.text}</div>
        <div class="imdbc-rv-foot">
          <button type="button" class="imdbc-btn imdbc-btn-ghost" data-imdbc-rv-toggle hidden>Read more</button>
          ${r.up ? html`<span>${num(r.up)} of ${num(r.up + r.down)} found this helpful</span>` : ''}
          ${href ? html`<a href="${href}" class="imdbc-note">permalink</a>` : ''}
        </div>
      </article>`;
  }

  function wireTitleReviews(root, t) {
    const list = root.querySelector('[data-imdbc-review-list]');
    const more = root.querySelector('[data-imdbc-review-more]');
    const sortSel = root.querySelector('[data-imdbc-review-sort]');
    if (!list) return;

    const perPage = Math.max(5, Math.min(50, parseInt(settings.reviewCount, 10) || 10));
    const state = { sort: 'top', cursor: null, hasMore: false, items: [], token: 0 };

    // `clamped` is on every body at render time, and its fade is anchored to the
    // rendered bottom edge rather than to the clamp line, so a review that fits
    // would still get a gradient over its last lines. Measure, then release.
    function unclampShortReviews() {
      for (const body of list.querySelectorAll('[data-imdbc-rv-body]')) {
        if (body.scrollHeight > body.clientHeight + 4) {
          const btn = body.closest('.imdbc-review').querySelector('[data-imdbc-rv-toggle]');
          if (btn) btn.hidden = false;
        } else {
          body.classList.remove('clamped');
        }
      }
    }

    function paint() {
      if (!state.items.length) {
        list.innerHTML = interpolate(html`<div class="imdbc-empty">No user reviews.</div>`);
      } else {
        list.innerHTML = state.items.map((r) => interpolate(reviewCard(r))).join('');
      }
      more.innerHTML = state.hasMore
        ? '<button type="button" class="imdbc-btn" data-imdbc-rv-more>Load more reviews</button>'
        : '';
      unclampShortReviews();
    }

    async function load(reset) {
      const token = ++state.token;
      if (reset) { state.items = []; state.cursor = null; state.hasMore = false; }
      more.innerHTML = '<span class="imdbc-loading">loading reviews</span>';
      try {
        const page = await fetchReviews(t.id, state.sort, perPage, state.cursor);
        if (token !== state.token || !root.isConnected) return;
        state.items = state.items.concat(page.reviews);
        state.cursor = page.cursor;
        state.hasMore = page.hasMore;
        paint();
      } catch (e) {
        warn('review fetch failed', e);
        if (token !== state.token || !root.isConnected) return;
        if (!state.items.length && t.featuredReviews.length) {
          state.items = t.featuredReviews.slice();
          state.hasMore = false;
          paint();
          more.innerHTML = interpolate(html`<span class="imdbc-note">Showing IMDb's featured reviews — the full list could not be loaded.</span>`);
        } else {
          paint();
          more.innerHTML = interpolate(html`<span class="imdbc-note">Reviews could not be loaded. <a href="${titleUrl(t.id) + 'reviews/'}">Open them on IMDb</a>.</span>`);
        }
      }
    }

    list.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-imdbc-rv-toggle]');
      if (toggle) {
        const body = toggle.closest('.imdbc-review').querySelector('[data-imdbc-rv-body]');
        const clamped = body.classList.toggle('clamped');
        body.classList.remove('spoiler');
        toggle.textContent = clamped ? 'Read more' : 'Show less';
        return;
      }
      const body = e.target.closest('.imdbc-rv-body.spoiler');
      if (body) body.classList.remove('spoiler');
    });

    more.addEventListener('click', (e) => { if (e.target.closest('[data-imdbc-rv-more]')) load(false); });
    if (sortSel) sortSel.addEventListener('change', () => { state.sort = sortSel.value; load(true); });

    if (t.reviewTotal === 0 && !t.featuredReviews.length) { paint(); return; }
    load(true);
  }

  async function wireSeasons(root, t) {
    const host = root.querySelector('[data-imdbc-season-list]');
    if (!host) return;
    const seasons = t.episodes.seasons;
    if (!seasons.length) {
      host.innerHTML = interpolate(html`<span class="imdbc-empty">${num(t.episodes.total)} episodes.</span>`);
      return;
    }
    let counts = {};
    try {
      counts = await memoizeDisk('seasons:' + t.id, 24 * 3600 * 1000, () => fetchSeasonCounts(t.id, seasons));
    } catch (e) {
      warn('season counts failed', e);
    }
    if (!root.isConnected) return;

    const known = Object.keys(counts).length > 0;
    host.innerHTML = seasons.map((s) => interpolate(html`
      <a class="imdbc-season" href="${titleUrl(t.id) + 'episodes/?season=' + encodeURIComponent(s)}">
        <div class="s">Season ${s}</div>
        <div class="e">${known && counts[s] !== undefined ? html`${counts[s]} <small>ep</small>` : html`<small>view</small>`}</div>
      </a>`)).join('')
      + (t.episodes.unknownSeason
        ? interpolate(html`<div class="imdbc-season"><div class="s">Unknown season</div><div class="e">${t.episodes.unknownSeason} <small>ep</small></div></div>`)
        : '');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 13. Person page
  // ══════════════════════════════════════════════════════════════════════════

  function renderPerson(root, p) {
    const photo = thumb(p.photo, 400, 600, p.photoSize);
    const born = imdbDateText(p.birthDate);
    const died = imdbDateText(p.deathDate);
    const age = ageFrom(p.birthDate, p.deathDate);

    const lifeLines = [];
    if (born) {
      lifeLines.push(interpolate(html`<div><span class="k">Born</span> ${born}${age !== null && !died ? ` (age ${age})` : ''}${p.birthPlace ? ` · ${p.birthPlace}` : ''}</div>`));
    }
    if (died) {
      lifeLines.push(interpolate(html`<div><span class="k">Died</span> ${died}${age !== null ? ` (age ${age})` : ''}${p.deathPlace ? ` · ${p.deathPlace}` : ''}</div>`));
    }
    if (p.height) lifeLines.push(interpolate(html`<div><span class="k">Height</span> ${p.height}</div>`));

    root.innerHTML = interpolate(html`
      ${topBar(nameUrl(p.id))}
      <div class="imdbc-wrap">
        <div class="imdbc-hero">
          <div>
            <div class="imdbc-hero-poster">
              ${photo ? html`<img src="${photo}" alt="Photo of ${p.name}" decoding="async">` : ''}
            </div>
          </div>
          <div>
            <h1 class="imdbc-h1">${p.name}</h1>
            ${p.professions.length ? html`<div class="imdbc-sub">${raw(p.professions.map(esc).join('<span class="dot">·</span>'))}</div>` : ''}
            ${lifeLines.length ? html`<div class="imdbc-crew">${raw(lifeLines.join(''))}</div>` : ''}
            ${p.bio ? html`
              <p class="imdbc-bio clamped" data-imdbc-bio>${p.bio}</p>
              <button type="button" class="imdbc-btn imdbc-btn-ghost" data-imdbc-bio-toggle>Read full bio</button>` : ''}
          </div>
        </div>

        ${raw(videoSection(p))}

        ${p.knownFor.length ? html`
          <section class="imdbc-sec">
            ${sectionHead('Known for', '')}
            <div class="imdbc-knownfor">${p.knownFor.map(knownForCard)}</div>
          </section>` : ''}

        <section class="imdbc-sec" data-imdbc-credits>
          ${sectionHead('Credits', '…', html`
            <input type="search" data-imdbc-credit-filter placeholder="Filter title or character" aria-label="Filter credits">
            <select data-imdbc-credit-sort aria-label="Sort credits">
              <option value="year-desc">Newest first</option>
              <option value="year-asc">Oldest first</option>
              <option value="rating">Highest rated</option>
              <option value="votes">Most voted</option>
            </select>`)}
          <div class="imdbc-tools" data-imdbc-credit-tabs style="margin-bottom:14px"></div>
          <div class="imdbc-credits" data-imdbc-credit-list></div>
          <div class="imdbc-more" data-imdbc-credit-more></div>
        </section>

        ${raw(photoSection(p))}
      </div>`);

    wireTopBar(root);
    wireBio(root);
    wireMedia(root, p);
    wireCredits(root, p);
  }

  function knownForCard(c) {
    const poster = thumb(c.poster, 240, 360, c.posterSize);
    const role = c.characters && c.characters.length ? c.characters.join(' / ') : (c.roleText || c.category || '');
    return html`
      <div class="imdbc-card">
        <a class="po" href="${titleUrl(c.id)}" tabindex="-1" aria-hidden="true">
          ${poster ? html`<img src="${poster}" alt="" loading="lazy" decoding="async">` : ''}
        </a>
        <div>
          <div class="ti"><a href="${titleUrl(c.id)}">${c.title}</a></div>
          ${role ? html`<div class="mt"><span>as ${role}</span></div>` : ''}
          <div class="mt">
            ${c.year ? html`<span>${c.year}</span>` : ''}
            ${typeof c.rating === 'number' ? html`<span class="rt ${ratingClasses(c.rating, 10, c.votes)}">★ ${c.rating.toFixed(1)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }

  function wireBio(root) {
    const btn = root.querySelector('[data-imdbc-bio-toggle]');
    const bio = root.querySelector('[data-imdbc-bio]');
    if (!btn || !bio) return;
    // Nothing to expand if it already fits.
    if (bio.scrollHeight <= bio.clientHeight + 4) { btn.remove(); bio.classList.remove('clamped'); return; }
    btn.addEventListener('click', () => {
      const clamped = bio.classList.toggle('clamped');
      btn.textContent = clamped ? 'Read full bio' : 'Show less';
    });
  }

  const CREDIT_PAGE = 60;
  const NOISE_CATEGORIES = /^(self|archive footage|thanks)$/i;
  const ALL_CATEGORIES = '--all-credits--';

  function creditRow(c) {
    const poster = thumb(c.poster, 88, 132, c.posterSize);
    const type = c.typeText && c.typeText !== 'Movie' ? c.typeText : '';

    let role = '';
    if (c.characters && c.characters.length) role = interpolate(html`as <b>${c.characters.join(' / ')}</b>`);
    else if (c.roleText) role = interpolate(html`<b>${c.roleText}</b>`);
    else if (c.category) role = interpolate(html`${c.category}`);
    if (c.attributes && c.attributes.length) role += interpolate(html` <span class="imdbc-note">(${c.attributes.join(', ')})</span>`);
    const others = creditCategories(c).filter((k) => k !== c.category);
    if (others.length) role += interpolate(html` <span class="imdbc-note">· also ${others.join(', ')}</span>`);

    let eps = '';
    if (c.episodeCount) {
      const numbered = (c.seasons || []).filter((x) => /^[0-9]+$/.test(String(x)));
      const seasonBit = numbered.length === 1 ? `S${numbered[0]}`
        : numbered.length > 1 ? `S${numbered[0]}–S${numbered[numbered.length - 1]}`
        : '';
      eps = `${num(c.episodeCount)} episode${c.episodeCount === 1 ? '' : 's'}${seasonBit ? ' · ' + seasonBit : ''}${c.episodeYears ? ' · ' + c.episodeYears : ''}`;
    }

    return html`
      <div class="imdbc-credit">
        <div class="yr">${c.year || '—'}</div>
        <a class="po" href="${titleUrl(c.id)}" tabindex="-1" aria-hidden="true">
          ${poster ? html`<img src="${poster}" alt="" loading="lazy" decoding="async">` : ''}
        </a>
        <div class="main">
          <div class="ti"><a href="${titleUrl(c.id)}">${c.title}</a>${type ? html`<span class="tt">${type}</span>` : ''}</div>
          ${c.seriesTitle ? html`<div class="eps">${c.seriesTitle}</div>` : ''}
          ${role ? html`<div class="role">${raw(role)}</div>` : ''}
          ${eps ? html`<div class="eps">${eps}</div>` : ''}
        </div>
        <div class="rt ${ratingClasses(c.rating, 10, c.votes)}">${typeof c.rating === 'number' ? html`★ ${c.rating.toFixed(1)}<small> ${compactNum(c.votes)}</small>` : ''}</div>
      </div>`;
  }

  function wireCredits(root, p) {
    const listEl = root.querySelector('[data-imdbc-credit-list]');
    const moreEl = root.querySelector('[data-imdbc-credit-more]');
    const tabsEl = root.querySelector('[data-imdbc-credit-tabs]');
    const filterEl = root.querySelector('[data-imdbc-credit-filter]');
    const sortEl = root.querySelector('[data-imdbc-credit-sort]');
    const countEl = root.querySelector('[data-imdbc-credits] .count');
    if (!listEl) return;

    const state = {
      all: p.credits.slice(),
      complete: false,
      category: null,
      filter: '',
      sort: 'year-desc',
      shown: CREDIT_PAGE
    };

    function categories() {
      const counts = new Map();
      for (const c of state.all) {
        for (const key of creditCategories(c)) counts.set(key, (counts.get(key) || 0) + 1);
      }
      // Until the full list arrives, prefer IMDb's own totals so the tab
      // numbers are not silently wrong.
      if (!state.complete) {
        for (const [k, v] of Object.entries(p.groupTotals)) if (v) counts.set(k, v);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }

    function defaultCategory(cats) {
      const acting = cats.find(([k]) => /^actor$|^actress$|^acting$/i.test(k));
      if (acting) return acting[0];
      const meaty = cats.find(([k]) => !NOISE_CATEGORIES.test(k));
      return meaty ? meaty[0] : (cats[0] ? cats[0][0] : null);
    }

    function visible() {
      let list = state.all;
      if (state.category && state.category !== ALL_CATEGORIES) {
        list = list.filter((c) => creditCategories(c).includes(state.category));
      } else if (state.category !== ALL_CATEGORIES && settings.hideSelfCredits) {
        // Hide only credits that are nothing BUT noise.
        list = list.filter((c) => !creditCategories(c).every((k) => NOISE_CATEGORIES.test(k)));
      }

      if (state.filter) {
        const q = state.filter.toLowerCase();
        list = list.filter((c) => c.title.toLowerCase().includes(q)
          || (c.characters || []).some((ch) => ch.toLowerCase().includes(q))
          || (c.seriesTitle || '').toLowerCase().includes(q)
          || (c.roleText || '').toLowerCase().includes(q));
      }

      const by = state.sort;
      list = list.slice().sort((a, b) => {
        if (by === 'rating') return (b.rating || -1) - (a.rating || -1);
        if (by === 'votes') return (b.votes || -1) - (a.votes || -1);
        const ay = a.startYear || (by === 'year-asc' ? 9999 : -1);
        const byr = b.startYear || (by === 'year-asc' ? 9999 : -1);
        return by === 'year-asc' ? ay - byr : byr - ay;
      });
      return list;
    }

    function paintTabs() {
      const cats = categories();
      if (state.category === null && cats.length) state.category = defaultCategory(cats);
      tabsEl.innerHTML = cats.map(([k, v]) => `<button type="button" class="imdbc-btn${k === state.category ? ' is-on' : ''}" data-imdbc-cat="${esc(k)}">${esc(k)} <span style="opacity:.6">${esc(num(v))}</span></button>`).join('')
        + `<button type="button" class="imdbc-btn${state.category === ALL_CATEGORIES ? ' is-on' : ''}" data-imdbc-cat="${esc(ALL_CATEGORIES)}">Everything <span style="opacity:.6">${esc(num(state.all.length))}</span></button>`;
    }

    function paint() {
      const list = visible();
      if (countEl) countEl.textContent = num(list.length) + (state.complete ? '' : '+');
      const slice = list.slice(0, state.shown);
      listEl.innerHTML = slice.length
        ? slice.map((c) => interpolate(creditRow(c))).join('')
        : interpolate(html`<div class="imdbc-empty">Nothing here.</div>`);

      const bits = [];
      if (list.length > slice.length) {
        bits.push(`<button type="button" class="imdbc-btn" data-imdbc-credit-more-btn>Show ${esc(num(Math.min(CREDIT_PAGE, list.length - slice.length)))} more of ${esc(num(list.length))}</button>`);
      }
      if (!state.complete) bits.push('<span class="imdbc-loading">loading the full filmography</span>');
      else if (state.error) {
        bits.push(`<span class="imdbc-note">Only the credits IMDb ships with the page could be loaded. <a href="${esc(nameUrl(p.id))}">See all on IMDb</a>.</span>`);
      }
      moreEl.innerHTML = bits.join('');
    }

    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-imdbc-cat]');
      if (!btn) return;
      state.category = btn.getAttribute('data-imdbc-cat');
      state.shown = CREDIT_PAGE;
      paintTabs();
      paint();
    });
    moreEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-imdbc-credit-more-btn]')) { state.shown += CREDIT_PAGE; paint(); }
    });
    if (filterEl) {
      let timer = null;
      filterEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.filter = filterEl.value.trim(); state.shown = CREDIT_PAGE; paint(); }, 140);
      });
    }
    if (sortEl) sortEl.addEventListener('change', () => { state.sort = sortEl.value; state.shown = CREDIT_PAGE; paint(); });

    paintTabs();
    paint();

    if (settings.fullCredits) {
      memoizeDisk('credits:' + p.id, 6 * 3600 * 1000, () => fetchAllCredits(p.id))
        .then((all) => {
          if (!root.isConnected || !all.length) return;
          state.all = dedupeCredits(all.concat(state.all));
          state.complete = true;
          paintTabs();
          paint();
        })
        .catch((e) => {
          warn('full credits fetch failed', e);
          if (!root.isConnected) return;
          // Mark complete so the tab counts fall back to what we can actually
          // show. Leaving IMDb's totals up would claim 133 credits above a list
          // of 21 — a lie that looks exactly like a working page.
          state.complete = true;
          state.error = true;
          paintTabs();
          paint();
        });
    } else {
      state.complete = true;
      paint();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 14. Top bar wiring + settings popover
  // ══════════════════════════════════════════════════════════════════════════

  function wireTopBar(root) {
    wireSuggest(root);
    const btn = root.querySelector('[data-imdbc-settings]');
    if (btn) btn.addEventListener('click', () => toggleSettings(root, btn));

    // "Original page" must escape our takeover rather than just follow a link
    // back to the same URL we are already on.
    const orig = root.querySelector('[data-imdbc-original]');
    if (orig) {
      orig.addEventListener('click', (e) => {
        // Compare the IMDb id, not the URL: host, trailing slash and ?ref_ all vary.
        const idOf = (u) => { const m = /\/(tt\d+|nm\d+)/.exec(u || ''); return m && m[1]; };
        if (idOf(orig.getAttribute('href')) && idOf(orig.getAttribute('href')) === idOf(location.pathname)) {
          e.preventDefault();
          release();
          showRestoreButton();
        }
      });
    }
  }

  /**
   * The single way back into the takeover. Both the floating button and the
   * menu command route through it, because re-adding the class alone blanks the
   * page whenever #imdbc-root is gone or empty.
   */
  function resumeTakeover() {
    const btn = document.getElementById('imdbc-restore');
    if (btn) btn.remove();
    const route = routeFor(location.pathname, location.search);
    if (!route) { release(); return; }
    document.documentElement.classList.remove('imdbc-off');
    document.documentElement.classList.add('imdbc-on');
    const root = document.getElementById('imdbc-root');
    if (!root || !root.firstChild) {
      currentRoute = route;
      render(route);
    }
  }

  function showRestoreButton() {
    if (document.getElementById('imdbc-restore')) return;
    const b = document.createElement('button');
    b.id = 'imdbc-restore';
    b.type = 'button';
    b.textContent = 'Back to Recut';
    b.setAttribute('style', [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'padding:9px 15px', 'border-radius:999px', 'border:1px solid #444',
      'background:#111', 'color:#f5c518', 'font:600 13px system-ui, sans-serif',
      'cursor:pointer', 'box-shadow:0 4px 16px rgba(0,0,0,.35)'
    ].join(';'));
    b.addEventListener('click', resumeTakeover);
    document.body.appendChild(b);
  }

  function toggleSettings(root, anchor) {
    const existing = root.querySelector('.imdbc-panel-pop');
    if (existing) { existing.remove(); return; }

    const pop = document.createElement('div');
    pop.className = 'imdbc-panel-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Recut settings');
    pop.innerHTML = interpolate(html`
      <h3>Recut</h3>
      <div class="imdbc-set-row">
        <label for="imdbc-set-theme">Theme</label>
        <select id="imdbc-set-theme" data-set="theme">
          ${SETTING_DEFS.theme.options.map((o) => html`<option value="${o}"${settings.theme === o ? raw(' selected') : ''}>${o}</option>`)}
        </select>
      </div>
      ${['rottenTomatoes', 'trailers', 'photos', 'fullCast', 'fullCredits', 'hideSelfCredits', 'declineCookies'].map((k) => html`
        <div class="imdbc-set-row">
          <label for="imdbc-set-${k}">${SETTING_DEFS[k].label}</label>
          <input id="imdbc-set-${k}" type="checkbox" data-set="${k}"${settings[k] ? raw(' checked') : ''}>
        </div>`)}
      <div class="imdbc-set-row">
        <label for="imdbc-set-reviewCount">${SETTING_DEFS.reviewCount.label}</label>
        <select id="imdbc-set-reviewCount" data-set="reviewCount">
          ${[5, 10, 25, 50].map((v) => html`<option value="${v}"${Number(settings.reviewCount) === v ? raw(' selected') : ''}>${v}</option>`)}
        </select>
      </div>
      <div class="imdbc-set-row">
        <button type="button" class="imdbc-btn" data-imdbc-clear-cache>Clear cached scores</button>
      </div>
      <div class="imdbc-note">Changes apply on reload.</div>`);

    pop.addEventListener('change', (e) => {
      const el = e.target.closest('[data-set]');
      if (!el) return;
      const key = el.getAttribute('data-set');
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (key === 'reviewCount') value = parseInt(value, 10) || SETTING_DEFS.reviewCount.def;
      saveSetting(key, value);
      if (key === 'theme') applyTheme();
    });
    pop.addEventListener('click', (e) => {
      if (e.target.closest('[data-imdbc-clear-cache]')) {
        diskClear();
        memCache.clear();
        e.target.textContent = 'Cleared';
      }
    });

    root.querySelector('.imdbc-bar').appendChild(pop);

    const away = (e) => {
      if (pop.contains(e.target) || (anchor && anchor.contains(e.target))) return;
      pop.remove();
      document.removeEventListener('mousedown', away, true);
    };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 15. Failure surface — never leave a blank page behind
  // ══════════════════════════════════════════════════════════════════════════

  function renderFailure(root, route, err) {
    const href = route.kind === 'search' ? findUrl(route.query, route.section)
      : route.sub ? titleUrl(route.id) + route.sub + '/'
      : (route.kind === 'chart' || route.kind === 'list' || route.kind === 'titleSearch') ? listPageUrl(route)
      : route.kind === 'title' ? titleUrl(route.id) : nameUrl(route.id);
    root.innerHTML = interpolate(html`
      ${topBar(href, route.kind === 'search' ? route.query : '')}
      <div class="imdbc-wrap">
        <div class="imdbc-fail">
          <h2>Recut could not read this page</h2>
          <p class="imdbc-note">${err && err.message ? err.message : String(err)}</p>
          <p><button type="button" class="imdbc-btn" data-imdbc-show-original>Show the original IMDb page</button></p>
        </div>
      </div>`);
    wireTopBar(root);
    const btn = root.querySelector('[data-imdbc-show-original]');
    if (btn) btn.addEventListener('click', () => { release(); showRestoreButton(); });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 16. Controller
  // ══════════════════════════════════════════════════════════════════════════

  let currentRoute = null;
  let renderSeq = 0;
  let mediaObserver = null;

  function ensureRoot() {
    let root = document.getElementById('imdbc-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'imdbc-root';
      document.body.appendChild(root);
    }
    return root;
  }

  async function render(route) {
    const seq = ++renderSeq;
    closeLightbox();
    takeOver();

    // The root has to exist before <body> does on a document-start run.
    await domReady();
    if (seq !== renderSeq) return;

    const root = ensureRoot();
    root.innerHTML = interpolate(html`<div class="imdbc-wrap" style="padding-top:64px"><span class="imdbc-loading">Loading ${route.id}</span></div>`);
    if (!mediaObserver) mediaObserver = silenceBackgroundMedia();

    // Paint the placeholder first, then wait for the payload. Reading it too
    // early makes payloadMatches fail and re-downloads the whole page.
    await payloadReady();
    if (seq !== renderSeq) return;

    try {
      const pp = await getPageProps(route);
      if (seq !== renderSeq) return;
      if (route.kind === 'title') renderTitle(root, normaliseTitle(pp));
      else if (route.kind === 'search') renderSearch(root, normaliseSearch(pp, route));
      else if (route.kind === 'titleRatings') renderTitleRatings(root, normaliseEntity(pp), normaliseRatings(pp));
      else if (route.kind === 'titleCredits') renderTitleCredits(root, normaliseEntity(pp), normaliseFullCredits(pp));
      else if (route.kind === 'titleEpisodes') renderTitleEpisodes(root, normaliseEntity(pp), normaliseEpisodes(pp));
      else if (route.kind === 'titleReviews') renderTitleReviews(root, normaliseEntity(pp), pp);
      else if (route.kind === 'chart' || route.kind === 'list' || route.kind === 'titleSearch') {
        renderTitleList(root, normaliseTitleListPage(pp, route), listPageUrl(route));
      }
      else renderPerson(root, normalisePerson(pp));
      document.documentElement.classList.remove('imdbc-off');
      window.scrollTo(0, 0);
    } catch (e) {
      warn('render failed', e);
      if (seq !== renderSeq) return;
      renderFailure(root, route, e);
    }
  }

  /** Resolves once the SSR payload script exists, or the document has finished. */
  function payloadReady() {
    if (document.getElementById('__NEXT_DATA__') || document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearInterval(timer);
        document.removeEventListener('DOMContentLoaded', finish);
        resolve();
      };
      const timer = setInterval(() => {
        if (document.getElementById('__NEXT_DATA__') || document.readyState === 'complete') finish();
      }, 20);
      document.addEventListener('DOMContentLoaded', finish);
      setTimeout(finish, 12000);
    });
  }

  function domReady() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => { if (document.body) { done(); } };
      const done = () => {
        document.removeEventListener('DOMContentLoaded', done);
        document.removeEventListener('readystatechange', check);
        clearInterval(timer);
        resolve();
      };
      const timer = setInterval(check, 20);
      document.addEventListener('DOMContentLoaded', done);
      document.addEventListener('readystatechange', check);
    });
  }

  function onRouteMaybeChanged() {
    const route = routeFor(location.pathname, location.search);
    const same = route && currentRoute && route.kind === currentRoute.kind
      && (route.routeId || route.id) === (currentRoute.routeId || currentRoute.id);
    if (same) return;
    currentRoute = route;
    if (!route) {
      renderSeq++;                       // cancel any in-flight render
      closeLightbox();
      release();
      const root = document.getElementById('imdbc-root');
      if (root) root.remove();
      // The restore button must go with it: clicking it on a page we never
      // rendered would hide IMDb and show nothing.
      const btn = document.getElementById('imdbc-restore');
      if (btn) btn.remove();
      return;
    }
    render(route);
  }

  function watchNavigation() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function () {
        const r = original.apply(this, arguments);
        setTimeout(onRouteMaybeChanged, 0);
        return r;
      };
    }
    window.addEventListener('popstate', () => setTimeout(onRouteMaybeChanged, 0));
    // Belt and braces: IMDb's router does not always go through history.
    let lastPath = location.pathname + location.search;
    setInterval(() => {
      const now = location.pathname + location.search;
      if (now !== lastPath) {
        lastPath = now;
        onRouteMaybeChanged();
      }
    }, 400);
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('Toggle original IMDb page', () => {
        if (document.documentElement.classList.contains('imdbc-off')) resumeTakeover();
        else { release(); showRestoreButton(); }
      });
      GM_registerMenuCommand('Clear cached Rotten Tomatoes scores', () => {
        diskClear();
        memCache.clear();
      });
    } catch (_) { /* some managers only allow this at document-idle */ }
  }

  // ── go ────────────────────────────────────────────────────────────────────

  // Runs on every IMDb page, not just the two we rewrite: declining once here
  // stops the banner reappearing on search results, episode lists and the rest.
  watchConsent();

  const initialRoute = routeFor(location.pathname, location.search);
  if (initialRoute) {
    currentRoute = initialRoute;
    // Hide IMDb's own markup before first paint so there is no flash of bloat.
    injectStyle('imdbc-style', CSS);
    document.documentElement.classList.add('imdbc-on');
    applyTheme();
    // If anything below throws, the page must still be usable.
    const watchdog = setTimeout(() => {
      const root = document.getElementById('imdbc-root');
      if (!root || !root.firstChild) {
        warn('watchdog fired — restoring the original page');
        release();
      }
    }, 8000);
    render(initialRoute).finally(() => clearTimeout(watchdog));
  }

  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });
    } catch (_) { /* older Safari */ }
  }

  watchNavigation();
  registerMenu();
})();
