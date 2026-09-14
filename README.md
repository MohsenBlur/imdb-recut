# Recut for IMDb

A userscript that replaces IMDb's pages with a dense, quiet layout.

It doesn't hide IMDb's markup with CSS. It reads IMDb's own data payload and
renders its own page, so the ads, video players, carousels and upsells are never
built in the first place.

[**Install**](#install) · [What it covers](#what-it-covers) · [How it works](#how-it-works) · [Tests](#tests)

---

### A film

Ratings from five sources in one strip, the full cast with characters, and
external links that are only shown when they actually resolve.

![A film page](docs/screenshots/title.png)

### Trailers and photos, without the bloat

One line: a small trailer preview and counts for the video and photo galleries.
Nothing expands until it is clicked. The trailer then plays inline from IMDb's
own MP4 sources rather than an embedded player, and photos open straight into a
keyboard-navigable lightbox without ever occupying page space.

![The media row](docs/screenshots/media.png)

### A person

The *complete* filmography — not the 15-per-category IMDb ships in the page —
with the character played on every row, category tabs, filtering and sorting.

![A person page](docs/screenshots/person.png)

### Ratings, episodes, charts

![The ratings breakdown](docs/screenshots/ratings.png)

![An episode list](docs/screenshots/episodes.png)

![The Top 250](docs/screenshots/chart.png)

---

## What it covers

| Page | What you get |
| --- | --- |
| `/title/tt…` | IMDb score, Metascore, Tomatometer, Popcornmeter and Letterboxd in one strip · trailer and video strip · full cast with characters and per-actor episode counts · sortable, paginated user reviews · seasons with per-season episode counts · photos · more-like-this · Letterboxd and Trakt links |
| `/name/nm…` | Known-for · the complete filmography with characters, category tabs, filter and sort · videos and photos |
| `/title/tt…/ratings` | 1–10 histogram and per-country breakdown |
| `/title/tt…/fullcredits` | Every cast member and crew department |
| `/title/tt…/episodes` | Season tabs, stills, air dates, ratings, plots |
| `/title/tt…/reviews` | The full review list, four sort orders |
| `/find`, `/search/title` | Search results as rows, plus type-ahead in the header |
| `/chart/…`, `/list/ls…` | Top 250, other charts, and user lists |

Every rating on every page is colour-banded on one scale — **≥8.0 green ·
7.0–7.9 lime · 6.0–6.9 amber · below 6.0 red** — so a filmography can be skimmed
without reading numbers. Ratings from fewer than 1,000 votes are dimmed, so an
obscure 9.8 from 14 votes doesn't outshout a classic.

The cookie consent banner is hidden and **declined** on every IMDb page, not
just the ones that get rewritten.

## Install

**1. Install a userscript manager**

| | Chrome / Brave / Vivaldi | Firefox | Edge | Safari |
| --- | --- | --- | --- | --- |
| **Tampermonkey** (recommended) | [install](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) | [install](https://addons.mozilla.org/firefox/addon/tampermonkey/) | [install](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) | [install](https://apps.apple.com/app/tampermonkey/id1482490089) |
| **Violentmonkey** | [install](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag) | [install](https://addons.mozilla.org/firefox/addon/violentmonkey/) | [install](https://microsoftedge.microsoft.com/addons/detail/violentmonkey/eeagobfjdenkkddmbclomhiblgggliao) | — |

Greasemonkey is untested. It only implements the promise-based `GM.*` API, and
while the script falls back to it, nothing here has been verified under it.

**2. [Install Recut](https://github.com/MohsenBlur/imdb-recut/raw/main/recut.user.js)**

Your manager intercepts that `.user.js` link and shows an install prompt. Then
open any IMDb page.

On first use it asks permission to reach `api.graphql.imdb.com`,
`query.wikidata.org`, `rottentomatoes.com`, `letterboxd.com` and `trakt.tv`.

## Settings

Top bar → **Settings**: theme (auto/dark/light), Rotten Tomatoes lookups,
trailers, photos, full-cast and full-filmography loading, hiding "Self" and
archive-footage credits, cookie-banner handling, reviews per page.

**Original page** in the top bar reveals IMDb's real page instantly, and a
floating button brings the clean view back. Tampermonkey's menu has the same
toggle for pages the script doesn't take over.

## How it works

1. **IMDb's page payload** (`__NEXT_DATA__`) — instant, no network. Enough to
   paint the whole page immediately.
2. **IMDb's public GraphQL API** for what IMDb withholds from the page: the full
   cast (the page ships ~18 of 158), the full filmography (15 per category), the
   review list, per-season episode counts. Results are cached to disk for six
   hours, bounded to 80 entries with LRU eviction.
3. **Wikidata → Rotten Tomatoes, Letterboxd and Trakt.** One SPARQL query maps
   the IMDb id to exact ids on all three (P1258, P8013/P12492), so there is no
   fuzzy title matching. Rotten Tomatoes' search page is a fallback that refuses
   to guess rather than show a same-named film from another decade.

Every request goes through `GM_xmlhttpRequest`, so page CSP and Rotten Tomatoes'
bot-detection wrapper around `window.fetch` are both irrelevant.

If the API is unreachable the page still renders from the payload and *says so*,
rather than quietly showing a short list under a large number.

## Tests

`test/` holds suites that slice the **real** functions out of `recut.user.js` —
they are not copies, so they fail when the script drifts — and run them against
live IMDb, Rotten Tomatoes, Wikidata, Letterboxd and Trakt.

```bash
cd test && npm install && for f in *-test.mjs gql-suite.mjs; do node "$f"; done
```

- `load-test.mjs` — executes the whole script in a synthetic DOM across twelve
  URLs. `node --check` only parses; this catches a temporal-dead-zone error or a
  typo'd identifier, either of which would kill the script on every page.
- `gql-suite.mjs` — cast pagination, all four review sort enums, cursor
  disjointness, 36 aliased season subqueries in one request, multi-role credits.
- `rt-test.mjs`, `letterboxd-test.mjs`, `trakt-test.mjs` — resolution against the
  live services, each including **known-bad probes that must be refused**, not
  guessed.
- `bands-test.mjs` — every rating-band boundary on all four score scales.
- `search-test.mjs` — search normalising, plus a hostile title that must not
  produce an element.

`tools/shots.mjs` regenerates the screenshots above by rendering the real script
against real IMDb data in headless Chrome. `test/preview.mjs` builds a page of
every component, viewable at any width — which is how the phone layout gets
checked, since Chrome won't make a window narrower than about 500px.

`RECON.md` records what was actually measured about these sites' data shapes,
including the things that turned out to be wrong the first time. Read it before
changing a query.

## Limits

- IMDb's GraphQL API is undocumented and unversioned. If IMDb changes it, the
  supplementary data degrades to what the page payload holds; the page keeps
  working.
- Trakt's web app returns HTTP 200 for every path, including ones that don't
  exist, so a link can't be validated by fetching it. The Trakt button appears
  only when Wikidata has a real id — no guessed slugs.
- Letterboxd is films-only. Trakt covers films, series and mini-series.
- IMDb's video playback URLs are signed and expire, so they are held in memory
  for the life of the page and never written to the cache.
- Signed-in features (your own ratings, watchlist) are not carried over.
- `/name/*/bio`, `/awards` and `/user/*/ratings` are still IMDb's own pages.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with IMDb. Uses IMDb's public endpoints for personal,
non-commercial use, per their stated terms.
