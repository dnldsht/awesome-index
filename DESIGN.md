# Design

The decisions behind the v2 rewrite, and the reasoning that is not recoverable
from the code. Settled 2026-09-12. Most of what the old site's memos agonised
over stops being a problem here; the section at the end says what is still open.

## The one change everything else follows from

The site stops being ~4,000 precomputed pages and becomes **80 documents that
load their own dataset and reorder it in memory**.

That is the whole rewrite. The current site bakes one order (stars descending)
into `reposForList()`, cuts it into 60-row slices, and emits a page per slice.
Every feature anyone has wanted since then (sort by activity, sort by curator
order, filter by language, show what is trending) collides with that shape,
because each one multiplies the page count and needs its own canonical and its
own `noindex`. The old memo on this listed four ways to work around a constraint
that only exists because the order is decided at build time.

It does not have to be. Measured on this dataset:

- 80 lists, **median 409 entries**, only 16 over 1,000, only 2 over 2,000. (80
  lists over 87 source READMEs: seven entries in `config.yaml` merge two.)
- The largest, `avelino/awesome-go`, is 3,044 `awesome_item` rows but **2,829
  renderable**: 215 point at repositories GitHub no longer serves, which have
  no name, URL or metadata and are dropped by the join. Built as a shard it is
  630 KB of JSON, **171 KB gzipped**, and that is the worst case in the corpus.

171 KB is a photograph. Ship the list to the browser and sorting it is
`.sort()`, filtering it is `.filter()`, and the category is a heading you scroll
to. No new URLs, no canonicals, no pagination arithmetic, nothing to reindex.

A second measurement decided the shape of the page: **4,350 categories, median 6
entries each**, only 80 over 60 entries. The curator's structure is not a
taxonomy to filter by; it is a **table of contents**. A dropdown with 4,350
values would be useless; a list of short sections beside a document that scrolls
is what the data actually is, and it is also what a newspaper looks like.

---

## Product

**Indexable: the 80 list pages. Not the 4,350 category pages.** Those are thin
pages of somebody else's README, and they are the reason every ordering feature
turned into a combinatorial problem. Eighty-seven substantial pages are easier
to defend than four thousand thin ones.

**No per-user state.** No accounts, no server-side writes. `localStorage` for
remembered filters is a later phase. A newspaper does not have a login.

**The home page is a front page**, not an index: what is climbing this week,
what has just entered a list, what has just been archived, and the list index
below. It is built from one small precomputed aggregate, and it is the only part
of the site that changes on its own every day, which is the difference between
a reference you consult once and a site you come back to.

**Non-GitHub links keep the curator's order.** Of 11,491 such targets, **10,098
(88%) carry no popularity signal at all**: not inherited stars, not a registry,
not a forge. The top hosts say what they are: youtube.com 547, metacpan.org 300,
twitter.com 177, medium.com, manning.com, gitlab.com 123, hackage.haskell.org
122, meetup.com 119. That population cannot be ranked, ever, and pretending
otherwise is exactly what the rest of this project avoids. The curator's order is
the only honest information we hold about them. Registry and forge adapters
(which would convert ~800 of them into rows with a real last-release date) are
deliberately deferred, not rejected.

**Name and domain unchanged** (`awesome-index`, `awesome.donld.me`). Revisit
before any launch push; the comment in the Astro config about the cost of moving
still applies.

---

## Architecture

**Nuxt with `nuxt generate`.** Static output, no server. Prerenders the home and
the 80 list routes; everything below that is client-side routing over data
already in memory.

**One JSON shard per list.** Built at build time, fetched when the page needs it.
The alternatives were considered and rejected on the measurement above: SQLite
compiled to WASM over HTTP Range requests costs ~1.2 MB of runtime, forfeits
compression (Range and gzip do not coexist), and issues dozens of requests to
answer a query that takes 2 ms against an array of 3,000 objects. DuckDB and
Parquet, the same objection with a larger runtime. The dataset is not big; it was
only ever distributed badly.

**No global cross-list search initially.** `q` filters within the loaded list,
which is nearly free and recovers most of what a global index would give. A
compact global index (~46,847 targets, id + name + stars + language) is the
obvious later addition; Pagefind is not, because Pagefind indexes _pages_ and the
pages are what we just stopped generating.

**All state in the query string**: `?sort=`, `?period=`, `?cat=`, `?q=`. Every
variant carries a canonical pointing at the bare list URL, so 4,350 category
states never compete with the page we want ranked. Query strings rather than
paths because a static host 404s on an unprerendered path, and this way there is
nothing to 404.

**Default order is the curator's**, not stars. It is the entry's editorial
position, it is what the old memos call "original", and it is the one order the
current site cannot produce.

**Prerendered HTML is a skeleton for now**; rows arrive from the JSON. This is a
deliberate deferral and it has a cost worth stating plainly: until it changes,
the 80 indexable pages contain nothing for a crawler to index, so the SEO bet
above currently returns zero. With `nuxt generate` the reverse (emitting all
rows into the HTML) is a build-time configuration change against the same
component, not a rewrite, so the deferral is cheap and reversible.

**Every row stays in the DOM**, with `content-visibility: auto` per section. The
browser skips layout for off-screen sections while the content remains findable,
which keeps `Ctrl+F` working across the entire list: on an index of projects
that is the feature people actually use, and virtualisation would break it. The
median category of 6 entries gives exactly the right granularity for the
property to apply to.

---

## Data

### Star history

**GitHub restricted `GET /repos/{owner}/{repo}/stargazers` on 2026-06-30**: it
returns 404 to anyone who is not an admin or collaborator, authenticated or not.
The page-sampling technique every star-history tool was built on is dead.

**`GET /repos/{owner}/{repo}/stargazers/history`, shipped 2026-09-04**, replaces
it. Verified against the live API on 2026-09-12:

- Returns `[{"week": <unix>, "total": n, "days": [7 ints]}, ...]`, newest first.
- **30 weeks per page**, regardless of `per_page`. Cost is driven by repo _age_,
  not star count: `anthropics/claude-code`, 144,823 stars, is 3 requests.
- Exact, not sampled: the totals reconstruct the current star count with zero
  delta. Archived repos return full history.
- `If-None-Match` works and **304s do not consume quota**. Pages ≥ 2 never
  change, so they are free forever after the first fetch.

**Address repositories by numeric ID** (`/repositories/{id}/...`). A rename
otherwise silently splits a repository's history in two. This requires
`databaseId` on the target table.

> **Never use `stargazers` on the GraphQL API.** Since the same restriction it
> returns `totalCount: 0` and an empty edge list **with no error**. Code that
> uses it writes zeros into the database and reports success.

### Depth: 14 months

Cost on this corpus (34,808 repositories with a creation date), at the
authenticated 5,000 req/hour limit:

| depth          | pages/repo |   requests |    hours |
| -------------- | ---------: | ---------: | -------: |
| ~7 months      |          1 |     34,808 |      7.0 |
| **~14 months** |      **2** | **68,749** | **13.7** |
| ~2 years       |          4 |    133,860 |     26.8 |
| ~3.5 years     |          6 |    196,154 |     39.2 |
| full           |        all |    549,867 |    110.0 |

Fourteen months covers every window the site offers plus a stable baseline for
the acceleration score, with two months of margin. Deeper history was wanted only
for the chart, and the chart now comes from elsewhere (below).

Because the endpoint pages backwards from the present, **going deeper later costs
only the extra pages**. Nothing about this decision is final.

### Trending

**Acceleration against the repository's own history**, with an absolute floor.

Absolute star deltas rank whatever is already large. React gains 400 a week
standing still, so "trending" becomes "big", which is the order we already have.
Percentage growth ranks noise: twelve stars to thirty is +150% forever.
Acceleration asks the question a reader means: this project normally gains three
a week and gained forty.

**The score sorts and is never displayed.** The row shows `+412 this week`, which
is a fact. This is the same rule `popularity.ts` already establishes for
synthetic star equivalents, and for the same reason: an ordering is a decision, a
rendered number is a claim.

**Windows: 7d / 30d / 1y, defaulting to 30d.** Seven days is the only window that
means _now_, but it is noise as a default because nobody visits an index of
awesome lists weekly. One year answers the different and useful question: is
this growing or has it stalled? Ninety days almost never says anything the other
two do not.

### Activity state

**Declared as one of: active / slow / stalled / archived.**

The trap this has to avoid is that **dead is not the same as finished**. Eighteen
months without a commit means abandonment for a TypeScript package and completion
for a C library, and fixed day thresholds are therefore systematically wrong about
an entire family of languages. Measured on this corpus, the oldest quartile of a
language cohort begins at **239 days for TypeScript, 298 for Rust, 934 for C,
1,000 for Go, 1,670 for JavaScript and 3,138 for Objective-C**, so "stalled"
means eight months in one language and eight and a half years in another.

(The example above originally said "npm package", which this data does not
support: the JavaScript cohort in an awesome-list corpus is itself mostly
abandoned, median 1,135 days idle, so an 18-month-idle JavaScript repository
comes out `slow`. The right conclusion is not a different threshold but that
`primary_language` is a mediocre proxy for ecosystem.)

So thresholds are **percentiles within the repository's language cohort**,
recomputed every crawl. "Stalled" means in the bottom quartile of activity
_among projects in that language in this dataset_. This is the mechanism
`popularity.ts` already uses and defends (rank inside a comparable cohort rather
than compare incomparable units), applied to a problem with the same shape. It
is self-calibrating, and nobody has to believe a hand-picked constant.

**The date is always shown beside the label**, so a reader can disagree with the
judgement while looking at the fact. `archived` is the one case where the author
declared the abandonment, so it is stated plainly.

**The signal is `pushed_at`.** This is the weakest link in the design and is
recorded as such: `pushed_at` cannot tell a README typo from forty commits by six
people, and a dependabot run moves it unaided. The language-cohort percentile
absorbs much of this, but not all. ecosyste.ms would fix it (one call per repo,
free, ~3 hours for the whole corpus, returning past-year commits, committers and
a bus-factor score), and is deliberately not being taken on now. If the "stalled"
label ever causes an argument, this is where to look first.

### Charts

**No inline sparkline.** The row carries four integers (Δ7d, Δ30d, Δ1y, state)
and nothing else from the history. The full curve appears on row expansion, via
**star-history.com's SVG** (MIT, verified serving 200 in 1.4 s, CORS-open,
24-hour edge cache): one request, on demand, one repository at a time, giving the
curve back to 2012 without storing a byte of it.

The consequence worth noting: the 14 months of history exist **only at build
time**, to compute the deltas. They never enter a payload.

### Refresh

Two jobs, both cheap:

- **Daily**: one GraphQL pass, 100 aliases per request, **350 requests for all
  35,000 repositories** (7% of the hourly quota) for `stargazerCount`,
  `pushedAt`, `isArchived`, `primaryLanguage`. Deleted repositories come back as
  `NOT_FOUND` without failing the batch, which is free dead-link detection.
  Batches of 200 exceed the node limit; 100 with a lean field set is 1 point.
- **Weekly**: page 1 only of `/stargazers/history` per repo, with
  `If-None-Match`. Self-healing against drift, and mostly free because most
  repositories gain no stars in a week and return 304.

---

## Visual direction

**Broadsheet, with a terminal graft.** No cards. Rules, not borders and shadows.

The reasoning is that the data is long lists and numbers, and the airy
one-column newsletter style, the obvious "modern minimal" default, handles long
lists worst: a roomy card per entry shows eight projects per screen on a list of
three thousand. A broadsheet is the form that was invented to hold a strong
hierarchy and a high density at the same time.

- **Two families**: an editorial serif for mastheads and project names, a
  monospace with tabular figures for numbers. Not three: the real contrast here
  is prose against figure, and a third family reads as disorder rather than as
  editing.
- **Rows ~32 px**, about 25 projects per screen, expanding on demand. Curator
  notes average 67 bytes, so they fit on one line nearly always. Twenty-five per
  screen means the reader actually scrolls the list; twelve means they see a
  twentieth of it and leave.
- **Light and dark**, the dark one designed rather than inverted: charcoal rather
  than black, serifs slightly heavier because they thin out on dark grounds.
  Light-only is defensible for a magazine and hostile for a technical index that
  developers consult all day.

---

## Deliberately out of scope

Registry and forge adapters · global cross-list search · `localStorage` ·
prerendered rows · history beyond 14 months · running the backfill on the
homelab · renaming the domain · ecosyste.ms.

None is precluded. The endpoint pages backwards, so deepening history later costs
only the additional pages; prerendering rows is a configuration change.

## Still open

`TODO.md` held the memos for the site this replaces and has been deleted: most
of it described a build-time-ordering problem that no longer exists, and the
rest is restated here so it is not carried around in a file about a dead
architecture. Recoverable from git if the measurements are ever wanted in full.

- **The homepage index.** 14,212 crawled repositories carry a `homepage_url`.
  Canonicalise both sides the way `targets.ts` does and **1,216 of the 11,491
  web targets (10.6%) match a repository already in the dataset; 843 (7.3%) are
  claimed by exactly one**, which is the safe subset. Those rows get real stars,
  a language and a pulse for zero extra API calls, and stop being an ordering
  problem at all. Two guards it needs, from the false positives the same sample
  threw: only when exactly one repository claims that canonical URL, and never
  on an aggregator host. A YouTube playlist matched `reduxjs/redux-devtools`
  because some repository lists it as its homepage. Still the cheapest real win
  available, and worth doing before anything that estimates importance.
- **A host facet.** The 11,491 web targets span **6,524 distinct hosts**, and
  the tail is what a facet would be for: the top 20 are 22% of them, and 164
  hosts with five or more cover 38%. What makes it worth building is that those
  hosts are _kinds_ of entry (registries, forges, reading, video, people),
  which is the classification this dataset deliberately does not store. Gated on
  the registry and forge adapters, which would shrink it first.
- **Read a full crawl before trusting the parser.** `looksLikeEntry` in
  `readme.ts` was written against 5 lists. The other 82 will have shapes it gets
  wrong in both directions. `pnpm crawl --only=<slug> --dry-run` prints the
  counts; nobody has yet read a few hundred of the rows it produces.
- **Notes still keep their licence tags** on the lists that write them in square
  brackets ("A very compact compression library for data streams. [zlib]"),
  because `dropTrailingTags` only knows the backticked form.

## Provenance

Figures in this document were measured against `data/awesome.db` on 2026-09-12
(34,808 GitHub targets, 11,491 web targets, 51,209 list entries, 80 lists over 87 source READMEs, 4,350
categories) and against the live GitHub API the same day. The shard figures were
remeasured after Wave 0 built the first one; the earlier 194 KB estimate counted
the 215 unrenderable rows.
