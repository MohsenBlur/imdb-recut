# IMDb / Rotten Tomatoes recon — observed 2026-09-14

Everything below was **observed in a live browser**, not inferred. Anything not
listed here was not verified.

## 1. IMDb pages are Next.js with a full SSR payload

`<script id="__NEXT_DATA__" type="application/json">` exists on both page types.
`window.next.router` exists, so IMDb **does** client-side routing. `buildId`
observed: `wQglpIp7ITqejhDt2ZrRt` — changes on every deploy, never hardcode it.

### Title page — `props.pageProps`

- `aboveTheFoldData`: `titleText`, `originalTitleText`,
  `titleType{id,text,isSeries,canHaveEpisodes}`, `releaseYear{year,endYear}`,
  `runtime{seconds,displayableProperty}`, `certificate{rating}`, `genres.genres[]`,
  `plot.plotText.plainText`, `primaryImage{url,width,height}`,
  `ratingsSummary{aggregateRating,voteCount,topRanking{rank}}`,
  `metacritic.metascore.score`, `series` (null for movies), `principalCreditsV2[]`,
  `featuredReviews.edges[]`, `castV2` (4 credits, names only — not useful).
- `mainColumnData`: `castV2[0]{grouping.text, totalCredits, credits[18]}` — the real
  cast, `crewV2[]`, `episodes{...}`, `moreLikeThisTitles.edges[12]`, `reviews.total`,
  `ratingsSummary`, `productionStatus`.

Cast credit shape (observed, tt2624370):

    credits[i] = { name: { id, nameText.text, primaryImage.url },
                   creditedRoles.edges[].node.characters.edges[].node.name,
                   episodeCredits { total, yearRange { year, endYear } } }

`totalCredits` was 110 but only **18** shipped in SSR, so the full cast needs GraphQL.

Episodes (tt2624370, observed): `episodes.episodes.total = 27`,
`episodes.seasons = [{number:1},{number:2},{number:3}]`,
`episodes.displayableSeasons.edges[].node.season = "1"|"2"|"3"`,
`episodes.isOngoing = false`. Per-season counts are **not** in SSR — GraphQL only (§2).

### Name page — `props.pageProps`

- `aboveTheFold`: `nameText`, `primaryImage`, `bio`, `professions`,
  `primaryProfessions`, `birthDate`, `deathDate`, `deathStatus`,
  `knownForV2.credits[]` (title text only — weak).
- `mainColumnData`: `knownForFeatureV2.credits[4]` — **rich** known-for (poster,
  rating, year, genres, character), `creditSummary.totalCredits.total` (510 for
  nm0000704), `groupings.edges[]` (category list + totals), `released.edges[]`,
  `unreleased.edges[]`, `birthLocation`, `deathLocation`, `height`, `akas`.

`released.edges[].node` = `{grouping:{text}, credits:{total, edges:[max 15]}}`.
Observed groups for nm0000704: Actor 128, Producer 24, Additional Crew 2,
Soundtrack 4, Director 1, Second Unit 1, Camera 1, Voice Dubbing 1, Thanks 10,
Self 283, Archive Footage 48.
**Only 15 per group ship in SSR**, including on `/fullcredits/` — which 302s to
`/name/<id>/?showAllCredits=true` and *still* ships 15. Full list needs GraphQL.

Credit node shape (observed):

    { title: { id, titleText.text, titleType{id,text,canHaveEpisodes},
               primaryImage.url, ratingsSummary{aggregateRating,voteCount},
               releaseYear{year,endYear}, runtime.seconds,
               titleGenres.genres[].genre.text, series },
      creditedRoles.edges[].node: {
               text, attributes[].text, category{text,traits},
               characters.edges[].node.name,
               episodeCredits{ total, yearRange,
                               displayableSeasons{total, edges[].node.season} } } }

`category.traits` observed: `CAST_TRAIT`, `CREW_TRAIT`, `SELF_TRAIT`,
`MAJOR_CREATIVE_INPUT_TRAIT`, `UNCATEGORIZED_TRAIT`, `ADDITIONAL_APPEARANCES_TRAIT`.

## 2. IMDb public GraphQL — `https://api.graphql.imdb.com/`

Open, no auth, GET with `?query=<urlencoded>`. Introspection is **blocked**
("Unauthorized introspection request") but field queries work. The response carries
a disclaimer limiting use to non-commercial/personal use — this script is personal use.

Verified working queries:

- **Full person credits, newest first** (default order is already newest-first):
  `{name(id:"nm..."){creditsV2(first:250){total pageInfo{hasNextPage endCursor} edges{node{...}}}}}`
  - `first:250` returned exactly 250, so 250 is an accepted page size.
  - `sort:` is **not** an argument on `Name.creditsV2` (error: `Unknown argument "sort"`).
  - Every nested connection needs its own `first:` or the query errors with
    *Query must have exactly one of 'first' or 'last' parameters*.
  - `creditsV2.total` = 484 while the name page's `creditSummary` said 510/513. The
    two counts differ; do not present them as the same number.

- **Full title cast**:
  `{title(id:"tt..."){credits(first:N, filter:{categories:["cast"]}){total pageInfo{...} edges{node{name{id nameText{text} primaryImage{url}} ... on Cast{characters{name} episodeCredits(first:1){total yearRange{year endYear}} attributes{text}}}}}}}`
  - `characters` is not on `Credit`; it requires the `... on Cast` inline fragment.
  - Here `characters` and `attributes` are **plain arrays**, not connections — unlike
    the name-page shape. The two schemas differ; do not share a parser.

- **Reviews**: `{title(id:"tt..."){reviews(first:N, sort:{by:X, order:DESC}){total edges{node{id author{nickName userId} summary{originalText} text{originalText{plainText}} authorRating submissionDate helpfulness{upVotes downVotes} spoiler}}}}}`
  - `ReviewsSortBy` values **verified by probe**: `TOTAL_VOTES`, `HELPFULNESS_SCORE`,
    `USER_RATING`, `SUBMISSION_DATE`. `HELPFULNESS` and `REVIEW_VOLUME` are invalid.

- **Per-season episode counts** (aliased, one round trip):
  `{title(id:"tt..."){episodes{ s1:episodes(first:0,filter:{includeSeasons:["1"]}){total} ... }}}`
  Verified tt2624370 → s1:9, s2:9, s3:9 (total 27).

- `metacritic{metascore{score reviewCount}}`, `ratingsSummary{topRanking{rank}}`,
  `moreLikeThisTitles(first:N)` and `productionStatus` all verified on tt0120737
  (Metascore 92 from 34 reviews, IMDb 8.9 from 2,236,310 votes, Top Rated rank 8).

## 3. Image resizing (verified)

`url.replace(/\._V1_.*?(\.\w+)$/, '._V1_QL75_UX<W>_CR0,0,<W>,<H>_$1')` returns a real
resized JPEG. Verified on three URL shapes, including one that already carried a
`_CR2,0,1574,2361_` segment. 140×207 thumbs came back at 5–10 KB versus multi-MB
originals.

## 4. Rotten Tomatoes

- RT search **is server-rendered** — raw HTML from
  `https://www.rottentomatoes.com/search?search=<q>` contains `<search-page-media-row>`
  elements, so `DOMParser` works. 20 rows observed for one query.
- Results split into `<search-page-result type="movie">` and `type="tvSeries">`.
- **Attribute names differ between the two blocks** (observed on the same page):
  - movie rows: `release-year`, `tomatometer-score`, `tomatometer-sentiment`,
    `tomatometer-is-certified`
  - tvSeries rows: `startyear`, `endyear`, `releaseyear`, `tomatometerscore`,
    `tomatometersentiment`

  A matcher must accept both spellings.
- Search rows carry **no audience score**. Only the title page has it.
- Title page has `<script id="media-scorecard-json" type="application/json">` holding
  `criticsScore{score,averageRating,reviewCount,certified,sentiment}` and
  `audienceScore{score,averageRating,likedCount,reviewCount,sentiment}`. Verified on
  `/m/the_lord_of_the_rings_the_fellowship_of_the_ring`: Tomatometer 91 (avg 8.80,
  271 reviews, certified), Popcornmeter 95 (avg 4.1).
- **rottentomatoes.com wraps `window.fetch`** with bot detection (`rt-common.js`) that
  throws on cross-origin calls. Irrelevant to a userscript using `GM_xmlhttpRequest`,
  but it meant recon had to run from the imdb.com origin.
- "Granite Flats" (tt2624370) has **no RT entry at all** — a real no-match case.

### Better than search: Wikidata gives the exact RT slug

`SELECT ?rt WHERE { ?item wdt:P345 "tt0120737" . ?item wdt:P1258 ?rt . }` against
`https://query.wikidata.org/sparql?format=json&query=...` returned
`m/the_lord_of_the_rings_the_fellowship_of_the_ring` in 7 ms. P345 = IMDb ID,
P1258 = Rotten Tomatoes ID. Exact mapping, no fuzzy title matching. Fall back to RT
search only when Wikidata has no P1258.

## 5. Not verified / deliberately unknown

- Whether `first:250` is the hard ceiling for `creditsV2` (250 worked; 1000 untested).
- Behaviour when logged in to IMDb — recon ran logged out. Ratings widgets and
  watchlist state may add SSR fields; none of the fields used here should change.
- RT scores for TV **seasons** (RT scores seasons separately). Only series-level
  `/tv/<slug>` was checked.

## 6. Corrections and additions, verified 2026-09-14 (second round)

These were all found *after* the script was installed in a real browser, and
every one of them invalidates something section 2 implied.

### The GraphQL endpoint rejects userscript requests unless you identify the client

Recon in section 2 ran `fetch()` from an open imdb.com page, so the browser
attached `Referer: https://www.imdb.com/...` automatically. `GM_xmlhttpRequest`
sends no Referer, and the endpoint answers **403 Forbidden** (an nginx HTML
page, not a GraphQL error). Probed matrix:

| headers | result |
| --- | --- |
| none / `Accept` / `Accept` + `Content-Type` / `User-Agent` / `+Origin` | **403** |
| `Referer` alone, `x-imdb-client-name` alone | 415 "Invalid content type" |
| `Content-Type: application/json` **and** (`Referer` or `x-imdb-client-name`) | **200** |

So two gates, not one. The script sends
`Content-Type: application/json` + `x-imdb-client-name: imdb-web-next`.
`x-imdb-client-name` is preferred over `Referer` because `Referer` is a
forbidden XHR header that not every userscript manager will set.

**The lesson worth keeping: section 2 was verified in the wrong configuration.**
A green result from the page's own `fetch()` says nothing about the same request
made from a userscript.

### A creditsV2 node can carry several credited roles

Section 2 implied one role per credit. Probed across four people:

| person | nodes | multi-role nodes | max roles on one node |
| --- | --- | --- | --- |
| Elijah Wood | 250 | 23 | 4 |
| Clint Eastwood | 250 | 34 | 5 |
| Ben Affleck | 250 | 31 | 4 |
| Jordan Peele | 231 | 27 | 16 |

Ben Affleck's *Animals* is a single node whose roles are
`Producer + Actor + Writer + Director`. Reading only `creditedRoles.edges[0]`
files such a title under one category and undercounts every other tab.
`creditedRoles(first: 12)` covers all observed cases.

### episodeCredits sits in two different places

- Page payload (`released.edges[].node`): `episodeCredits` is a sibling of
  `creditedRoles`, i.e. **on the credit node**.
- `creditsV2` as queried here: `episodeCredits` is **under the role**.

Verified on Yellowjackets: `episodeCredits on node? false | on role? true`.
A parser that reads only one of the two silently drops every episode count.

### topRanking exists only in mainColumnData

On tt0120737, `aboveTheFoldData.ratingsSummary` is exactly
`{aggregateRating, voteCount, __typename}` — no `topRanking`. Only
`mainColumnData.ratingsSummary` carries `topRanking.rank` (8). An
`aboveTheFold || mainColumn` fallback therefore loses the Top-250 rank on every
title.

### Page sizes and shapes confirmed at scale

- `title.credits` paginates correctly: 158 cast for tt0120737, 110 for tt2624370.
- `title.reviews` accepts all four verified sort enums; `after:`/`endCursor`
  pages are disjoint. tt0120737 reports 6,086 reviews.
- 36 aliased per-season subqueries in one request works (The Simpsons, 789 eps).
- `name.creditsV2` full fetch: 484 (Elijah Wood) / 545 (Affleck) / 649
  (Eastwood) in 2-3 requests of 250.

### IMDb is behind a WAF for non-browser clients

Server-side `fetch()` of an IMDb **page** returns a 202 AWS WAF challenge
(~2 KB, no `__NEXT_DATA__`) regardless of headers. `api.graphql.imdb.com` is
**not** behind it. Rotten Tomatoes and Wikidata are not either. This is why the
page HTML can only be read from inside a real browser session.

### Rotten Tomatoes matching, measured

Wikidata P345 -> P1258 resolved correctly for every title tried, and RT search
independently agreed each time: LOTR Fellowship, Yellowjackets, Ghostbusters
(1984), Interstellar (`m/interstellar_2014` — the slug carries a year the title
does not), Breaking Bad. Granite Flats correctly produced no match from either
route. An invented title is refused.

RT has no page for `tvEpisode`, `videoGame` or podcast types — searching for
one returns whatever film shares the name. Episodes are looked up via their
parent series instead (verified: Breaking Bad's *Felina* shows 96% / 97%).

### Browser-side gotcha that is not about IMDb at all

The CSS resets were written as `#imdbc-root a {...}` / `#imdbc-root button {...}`.
An id selector outranks any later class rule, so `.imdbc-btn.is-on` could set the
background but not the text colour — the selected tab rendered its label in its
own background colour. `:where(#imdbc-root)` drops the id's specificity to zero
and fixes the whole class of problem.

## 7. Letterboxd, and the image-crop trap (observed 2026-09-14, third round)

### Amazon's `_CR_` directive pads, it does not crop

Measured on a real headshot (source 1000x1178, asked for a 180x270 box):

| request | returned | note |
| --- | --- | --- |
| `._V1_QL75_UX180_CR0,0,180,270_.jpg` | 180x270, 4529 B | **white bars baked in** |
| `._V1_QL75_UX180_.jpg` | 180x212, 4221 B | too short for the box |
| `._V1_QL75_UY270_.jpg` | 230x270, 5838 B | covers the box; CSS crops |

So `_CR_` letterboxes with white when the scaled image is smaller than the crop
box, and that white is part of the JPEG — no CSS can remove it. Never crop
server-side. Scale along the axis that makes the image cover the box:

- source aspect **>** box aspect (relatively wider) -> `UY{h}`
- source aspect **<** box aspect (relatively taller) -> `UX{w}`
- unknown -> `UY{h}` is the safer default for a portrait box

The dimensions needed to choose are in the payloads (`primaryImage.width/height`)
and can be asked for in GraphQL (`primaryImage { url width height }`).

### Letterboxd

- `https://letterboxd.com/imdb/<tt-id>/` answers **302** to `/film/<slug>/` for
  films, features and shorts alike (verified tt0120737, tt0000012). For a TV
  series, an episode, or an unknown id it answers **200 with no redirect**
  (verified tt2624370, tt2301455, tt99999999) — so an unfiltered button lands on
  a not-found page. Gate on title type.
- The film page carries `<script type="application/ld+json">` with
  `aggregateRating`: `ratingValue` (out of `bestRating` 5), `ratingCount`,
  `reviewCount`. Verified on Fellowship: 4.39 from 3,252,529 ratings.
- **The JSON-LD is wrapped in CDATA comments** (`/* <![CDATA[ */ … /* ]]> */`),
  so it must be stripped before `JSON.parse`.
- One request serves both the link and the rating; no need to fetch twice.

### A cached value that changes shape is invisible to a TTL

v1.5.0 cached the Letterboxd result as a bare URL string. v1.6.0 expected an
object and read `.rating` off a string — `undefined`, so the tile silently did
not render, on an entry with 30 days left to live. TTLs expire stale *data*;
they do nothing about stale *shape*. The disk cache prefix now carries a schema
version (`cache:v2:`) that is bumped whenever a cached value's shape changes, and
readers check the shape anyway.

## 8. The homepage's own data (observed 2026-09-15, fourth round)

**Introspection is refused.** `{ __type(name: "Query") { fields { name } } }`
answers `Unauthorized introspection request. Token is invalid or missing` with
or without a client header. Field names have to be guessed — but a wrong guess
is informative: the error carries suggestions
(`recommendedTitles` → *Did you mean "topMeterTitles"?*), and a right guess with
missing arguments names the argument and its type. That is how the two fields
below were found without a schema.

**`topPicksTitles(first: Int!)` and `fanPicksTitles(first: Int!)` exist, and
both require an `x-amzn-sessionid` header.** Without it:

```
BAD_USER_INPUT exception code while fetching data (/fanPicksTitles)
  : The x-amzn-sessionid header is required
```

IMDb writes that value to a plain, script-readable `session-id` cookie on every
visit (measured in a signed-out browser: `session-id=146-…`, alongside
`session-id-time`, `ubid-main`, `aws-waf-token`). Passing any well-formed
session id is accepted; passing one the service has never seen returns the
**unpersonalised** list, which is exactly what a signed-out visitor should get.
Measured with a synthetic id:

| field | signed-out result |
| --- | --- |
| `topPicksTitles(first: 5)` | `edges: []` — personalised, needs a real account |
| `fanPicksTitles(first: 5)` | 5 titles: *The Odyssey*, *Spider-Man: Brand New Day*, … |

So the row is labelled for what it actually is: **Top picks** when the
personalised list has titles, **Fan favourites** otherwise. It is fetched as its
own query rather than folded into the popular-rows query, because `gql()` throws
on any GraphQL error and a per-field refusal would otherwise take the whole
homepage down with it.

`TOP_PICKS` is **not** a `ChartTitleType`. The valid values are
`MOST_POPULAR_MOVIES`, `MOST_POPULAR_TV_SHOWS`, `TOP_RATED_MOVIES`,
`TOP_RATED_TV_SHOWS`, `TOP_RATED_ENGLISH_MOVIES`.

**`recentVideos(limit: N)` is the homepage hero panel's data**, and needs no
session:

```
{ recentVideos(limit: 3) { videos {
    id name { value } runtime { value }
    thumbnail { url width height }
    primaryTitle { id titleText { text } } } } }
```

Returns e.g. `vi1318701593`, name `Trailer`, runtime 112 seconds, a 1280×720
thumbnail and a `primaryTitle`. Playback URLs come from the existing
`fetchVideo(id)`, so nothing loads until the card is clicked. Some thumbnails
have letterbox bars baked into the asset itself — measured, not a CSS fault.

## 9. `/chart/boxoffice/` is shaped differently from every other chart

Every other chart is `pageProps.pageData.chartTitles.edges[].node` — a title
with a `currentRank`. The box office chart is
`pageProps.pageData.topGrossingReleases`, keyed on **releases and takings**:

```
{ timeWindowStartDate: '2026-09-11', timeWindowEndDate: '2026-09-13',
  edges: [ { node: { gross: { total: { amount, currency } },
                     release: { weeksRunning, titles: [ <title> ] } } } ] }
```

The title inside carries `id`, `titleText`, `primaryImage`, `ratingsSummary`,
`plot`, `titleType` and `lifetimeGross` — but **no** `releaseYear`, `runtime`,
`certificate` or `titleGenres`, so those rows are legitimately sparser.

This was linked from the homepage from the day the homepage existed, and every
visit to it landed on the *"Recut could not read this page"* card: the route was
recognised (`boxoffice` is in `CHARTS`), so the takeover happened, and then the
payload guard — which only knew `chartTitles` — refused to draw. Recognising a
route and being able to render it are two different things, and only the first
one was ever tested.

`test/load-test.mjs` now walks every path the homepage links to and asserts the
takeover, and renders a trimmed real box-office payload end to end. Making that
second test possible exposed a third thing: the sandbox had no `window.scrollTo`,
which `render()` calls on every route — so *every* render in that suite had been
failing silently, and the suite only ever asserted "did not throw".

## 10. Season ratings, and the URL ceiling they hit (observed 2026-09-15)

**IMDb publishes no rating for a season.** Typo-probing for the "Did you mean"
hints (introspection is refused — see section 8) shows `EpisodeConnection`
answers only `total` and `edges`, and `LocalizedDisplayableSeason` only
`season`. There is nowhere for a season aggregate to live.

So it is derived: the **mean of the season's own episode ratings**, one aliased
request for every season:

```
sN: episodes(first: 250, filter: { includeSeasons: ["N"] }) {
      total edges { node { ratingsSummary { aggregateRating voteCount } } } }
```

Measured on The Simpsons: 40 seasons, 858 episodes, **one request, 1.7s, 55 KB**.

The mean is **unweighted**. Vote-weighting was measured against it across all 36
seasons then listed and moved every one by at most 0.13 — while letting a single
breakout episode speak for a whole season. Not worth the distortion.

The thin-data test uses **votes per rated episode**, not the season's summed
votes: `ratingClasses` asks whether a rating rests on enough data, and a sum
would let twenty flimsy episodes pass for one well-rated one.

Episodes with no rating are excluded rather than counted as zero. Game of
Thrones season 1 lists 11 episodes and rates 10. A season can also be listed and
scheduled with **nothing** rated — The Simpsons has three, 51 episodes between
them — and those must yield no rating at all, since the mean of nothing is NaN
and `NaN.toFixed(1)` renders the word "NaN" onto the page.

### The 414

`gql()` sent every query as a **GET with the query in the URL**, and IMDb
enforces the usual 8 KB ceiling. Binary-searched:

| seasons | query chars | URL chars | status |
| --- | --- | --- | --- |
| 36 | 4,920 | 7,942 | 200 |
| 40 | 5,464 | 8,814 | **414 URI Too Long** |

The first probe of this feature used 36 seasons and passed **with 250
characters to spare**. The real show has 40. Every long-running series would
have shown empty season tiles, and the probe that was supposed to prove the
approach sat just inside the limit that breaks it.

`gql()` now POSTs when the URL would exceed `GQL_URL_MAX` (7,000) and GETs
otherwise — short queries stay cacheable. `test/gql-suite.mjs` asks for all 40
seasons and asserts the request went out as a POST, so the ceiling cannot be
re-crossed silently.

Worth noting what did *not* catch this: `node --check`, the linkedom load test,
and a 36-season live test all passed. It took rendering a real 40-season show.

### One rating scale, two grounds

The selected season tab inverts to the page's text colour, so a band tuned for
the page washes out on it — bright green on near-white in the dark theme, and
the reverse in the light one. Each theme now also carries the other theme's band
values as `--rb-*-alt`, and one rule swaps them in on any inverted surface.

## 11. One entry that sets the height of a whole section (observed 2026-09-15)

Seen on the real Simpsons page, in the browser, with the script installed:

| | before | after |
| --- | --- | --- |
| document height | 51,670px | 7,991px |
| cast section | 46,252px | 2,539px |
| tallest cast card | 25,758px | 407px |

**A long-running voice role carries a four-figure character list.** Dan
Castellaneta has **1,299** characters on The Simpsons - 21,345 characters of
text - and one other cast member has **1,620**. Joined with " / " into one line
it made his card 25,758px tall; because CSS grid rows share a height, the other
five cards in his row stretched to match, and the cast section became 90% of the
page.

Three separate things had to be true for that, and all three are now fixed:

1. **The render joined the whole list.** Four places did, plus a dedupe key that
   built a 21 KB string per person on every keystroke of the cast filter. All go
   through `roleList()` now: four names, then `+1,295 more`.
2. **The fetch asked for every character.** `characters` takes `limit` (not
   `first` - the error message says so). Measured on one 250-cast page of this
   show: unbounded **207 KB**, `limit: 6` **82 KB**, `limit: 12` **86 KB**,
   `limit: 24` **91 KB**. 24 costs 11% more than 6 and keeps an exact remainder
   for all but 18 of the 250, so 24 it is. A list sitting exactly on the cap
   says `+ more` rather than claiming a total it does not have.
3. **The grid stretched the row.** `align-items: start` on `.imdbc-cast`, so an
   oversized card is one tall card and not six.

`.imdbc-person .ch` is also line-clamped, because none of the above bounds how
tall a single very long character *name* can make a card.

Separately, **40 season tiles wrapped into four banks** and pushed the cast off
the screen. The seasons row now scrolls sideways like the homepage rows: 117px
tall whether the show has 5 seasons or 40.

`test/load-test.mjs` asserts all four properties against the CSS and the source
rather than against a screenshot nobody re-reads, and `test/gql-suite.mjs`
fetches this show's cast and asserts nothing comes back over the cap.

One more instance of the temporal dead zone, in both the script and the test:
`CAST_FIELDS` is a template literal evaluated at load, so `ROLE_FETCH` has to be
declared above it. `node --check` passes either way - the load test is what
catches it, and the live suite caught its own copy of the same ordering bug.
