# Plan

How the v2 rewrite in `DESIGN.md` gets built, decomposed so that most of it can
run in parallel. Read `DESIGN.md` first; this file assumes its decisions and does
not re-argue them.

The organising idea: **the contracts in Wave 0 are what make the rest
parallelisable.** Once the shard schema and the metric signatures exist, the
person fetching star history, the person computing trending, the person building
the JSON and the person designing the page can all work at once against types
and fixtures instead of against each other.

Branch: `dev` (already created, based on `feat/urls` — `main` is missing
`targets.ts` and `liveness.ts`).

---

## Wave 0 — contracts and clearing. Sequential, nothing else starts first.

One agent, or by hand. Everything downstream depends on this landing.

### 0.1 Clear the presentation layer

**Delete**: `src/pages/`, `src/components/`, `src/layouts/`, `src/styles/`,
`astro.config.mjs`, `src/lib/{pagination,sitemap,jsonld,og,og-image,search,pagefind-dev,lucky,queries,emoji,format,slug,urls}.ts`,
`bin/index-search.ts`, and the Astro/Preact/Pagefind/Satori dependencies.

**Keep, untouched**: `src/lib/{readme,targets,github,liveness,popularity,config}.ts`,
`src/lib/db/`, `bin/{crawl,popularity}.ts`, `config.yaml`, `popularity.yaml`,
`migration/`, `data/`, `.github/workflows/deploy.yml` (rewritten in Wave 3).

`popularity.ts`, `bin/popularity.ts` and `popularity.yaml` are untracked as of
this writing. Commit them in this step or they exist in exactly one place on one
disk.

### 0.2 Schema

Add to `targetTable`:

```ts
/** GitHub's numeric repo id. Star history is fetched by id, not by name:
 *  a rename otherwise silently splits a repository's history in two. */
databaseId: integer("database_id"),
```

New table:

```ts
export const starHistoryTable = sqliteTable("star_history", {
  targetId: text("target_id").notNull(),
  /** unix timestamp of the week start, as GitHub returns it */
  week: integer("week").notNull(),
  /** net stars gained that week; may be negative */
  delta: integer("delta").notNull(),
}, (t) => [primaryKey({ columns: [t.targetId, t.week] })])
```

And a fetch-state table so the backfill is resumable and the weekly refresh can
send `If-None-Match`:

```ts
export const historyFetchTable = sqliteTable("history_fetch", {
  targetId: text("target_id").primaryKey().notNull(),
  /** deepest page successfully stored; the backfill resumes from page+1 */
  pagesDone: integer("pages_done").notNull().default(0),
  etagPage1: text("etag_page1"),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }),
  /** 404/451 etc. — stop asking */
  gone: integer("gone", { mode: "boolean" }).notNull().default(false),
})
```

Generate the migration with `pnpm db:generate`. Do not hand-write it.

### 0.3 `src/lib/contracts.ts` — the file that unblocks everyone

```ts
/** A row in a list shard. A tuple, not an object: at ~2,800 rows the repeated
 *  keys of an object form cost more than the data. Index constants below. */
export type Row = [
  id: string,
  title: string,
  note: string | null,
  kind: "github" | "web",
  url: string,
  position: number,
  stars: number | null,
  language: string | null,
  license: string | null,
  archived: 0 | 1,
  lastActivityAt: number | null,   // unix seconds
  d7: number | null,               // net stars, last 7 days
  d30: number | null,
  d365: number | null,
  state: ActivityState | null,
  trend: number | null,            // acceleration score; SORT KEY, NEVER RENDERED
]

export const ROW = { ID: 0, TITLE: 1, NOTE: 2, KIND: 3, URL: 4, POSITION: 5,
  STARS: 6, LANGUAGE: 7, LICENSE: 8, ARCHIVED: 9, LAST_ACTIVITY: 10,
  D7: 11, D30: 12, D365: 13, STATE: 14, TREND: 15 } as const

export type ActivityState = "active" | "slow" | "stalled" | "archived"

export type ListShard = {
  slug: string
  name: string
  icon: string
  sources: { id: string; url: string }[]
  crawledAt: number
  /** the curator's table of contents; `from`/`to` index into `rows`, which is
   *  stored in curator order so a section is a contiguous slice */
  sections: { slug: string; path: string[]; from: number; to: number }[]
  rows: Row[]
}

export type Ref = { listSlug: string; id: string; title: string; value: number }

export type FrontPage = {
  generatedAt: number
  climbing: { period: "7d" | "30d" | "1y"; rows: Ref[] }[]
  entered: Ref[]    // newly present in a list since the previous crawl
  archived: Ref[]   // archived flag flipped on since the previous crawl
  lists: { slug: string; name: string; icon: string; entries: number; repos: number }[]
}
```

Plus the signatures Wave 1 implements against, so B and C can be written
simultaneously:

```ts
export declare function trendScore(
  weekly: number[],            // oldest → newest, ~60 weeks
  opts?: { floor?: number },
): number | null

export declare function activityStates(
  repos: { id: string; language: string | null; lastActivityAt: number | null; archived: boolean }[],
): Map<string, ActivityState>
```

### 0.4 A fixture

Emit `fixtures/golang.json` and `fixtures/front-page.json` from the current
`data/awesome.db`, with `d7`/`d30`/`d365`/`state`/`trend` set to `null`. This
takes one query — the data is already there — and it is what lets the Nuxt work
start before any star history exists.

**Done when**: `pnpm db:migrate` applies cleanly, `contracts.ts` typechecks,
`fixtures/golang.json` exists and is under 250 KB gzipped.

---

## Wave 1 — four agents, in parallel. No shared files.

### A · Star history fetcher

**Owns** `bin/history.ts`, `src/lib/history.ts`.

Backfill and refresh against `GET /repositories/{databaseId}/stargazers/history`.

- Harvest `databaseId` for every GitHub target first, via a GraphQL batch (100
  aliases per request, ~350 requests for the whole corpus).
- 30 weeks per page. Default depth **2 pages**; `--pages=N` to go deeper. Because
  the endpoint pages backwards from now, deepening later fetches only pages
  `pagesDone+1 … N`.
- Send `If-None-Match` on page 1 and treat 304 as success with no write — 304s
  do not consume quota.
- Persist progress in `history_fetch` after every repo. The run must survive
  being killed at hour 2 of 3 and resume without refetching.
- Pace at **~1.4 req/s**. The limit is quota (5,000/hour), not the network;
  unthrottled this burns the hour in 85 seconds.
- `--only=<slug>[,<slug>]` to scope to lists, `--dry-run` to print the cost.

**Do not** call `stargazers` on GraphQL under any circumstances — since the June
2026 restriction it returns `totalCount: 0` with no error, and would write zeros.

**Done when**: `pnpm history --only=kubernetes` populates `star_history` for its
165 repos, a second run is a no-op via ETags, and `--dry-run` for the seven
prototype lists reports ≈13,900 requests.

### B · Metrics

**Owns** `src/lib/trending.ts`, `src/lib/activity.ts`, and their tests.

Pure functions over arrays. No network, no database — this is the one task that
is fully testable and should be fully tested.

- `trendScore(weekly)`: acceleration of the recent window against the
  repository's own baseline distribution of weekly deltas. Absolute floor so that
  3 → 9 stars does not outrank everything. Returns `null` when there is not
  enough history to judge. **This value sorts and is never rendered.**
- `activityStates(repos)`: thresholds as **percentiles within the language
  cohort**, recomputed per call. `archived: true` short-circuits to `"archived"`.
  Read `src/lib/popularity.ts` first — it solves the same shape of problem
  (rank inside a comparable cohort rather than compare incomparable units) and
  this should look like a sibling of it, including a minimum cohort size below
  which a language is left unranked rather than ranked on noise.

**Done when**: tests cover — a steady repo does not trend, a spiking repo does, a
tiny repo cannot trend through the floor, a C library idle 18 months is not
"stalled" while an npm package idle 18 months is, and an archived repo is
`"archived"` regardless of dates.

### C · Shard builder

**Owns** `bin/shards.ts`.

Reads the database, writes `public/data/<slug>.json` and
`public/data/front-page.json` per the `contracts.ts` types. Rows in **curator
order** so sections are contiguous slices — but group by section rather than
cutting wherever the slug changes: three (list, section) groups in the corpus
are non-contiguous in README order, and cutting on change would put the same
slug in the table of contents twice. Inner-join to `target`, as the old
`queries.ts` did and documents at length. Headingless rows (1,123 of them) go in
a bucket slugged `uncategorized`. `bin/fixtures.ts` from Wave 0 is a working
reference for all three rules and **must be matched exactly**, or the fixture
Wave 1 D builds against and the real shards will disagree. Imports B's functions by signature —
stub them locally if B has not landed.

Merged lists (MacOS = two sources, JavaScript, dotNET, Scala, Shell, Haskell,
Perl) have two positions for one target: order by source, then position, and
record both in `sources`.

**Done when**: all 80 shards build, the largest is ≤200 KB gzipped, and
`front-page.json` is under 50 KB.

### D · Nuxt scaffold and design system

**Owns** `nuxt.config.ts`, `app/`, `assets/`, `package.json` frontend deps.

Works entirely against `fixtures/` — no database, no crawl.

- `nuxt generate`, static output, prerender `/` and `/[list]`.
- Type scale, colour tokens, light + dark (designed, not inverted: charcoal
  ground, serifs slightly heavier on dark).
- Two families: editorial serif + monospace with tabular figures, both
  self-hosted via Fontsource as the repo already does.
- The **row component**: ~32 px, tabular, expanding on demand. No cards. Rules,
  not borders and shadows.
- `content-visibility: auto` per section. Verify `Ctrl+F` still finds a string in
  a section scrolled far off-screen — that is the whole reason for this choice.

**Done when**: `/golang` renders 2,829 rows from the fixture, both themes are
legible, `Ctrl+F` finds a row near the bottom, and it is smooth on a phone.

---

## Wave 2 — assembly. Two agents; both need C and D.

### E · List page

Sort and filter over the loaded shard, driven by `?sort=`, `?period=`, `?cat=`,
`?q=`. Section navigation from `shard.sections`. Canonical on every variant
pointing at the bare list URL. Default order is the curator's.

Row expansion loads the star-history SVG:
`https://api.star-history.com/svg?repos=<owner>/<repo>&type=Date` — on demand
only, never eagerly, never for a `web` row.

### F · Front page

The four rubrics from `front-page.json` plus the list index. This is the only
part of the site that changes daily, so it carries the editorial weight; it is
worth more design attention than its size suggests.

---

## Wave 3 — pipeline. One agent, after Wave 2 is verified.

Rewrite `.github/workflows/deploy.yml`:

- Restore the dataset from the `dataset` release asset (unchanged).
- **Daily**: `pnpm crawl` plus a GraphQL refresh — 100 aliases per request, ~350
  requests total — for `stargazerCount`, `pushedAt`, `isArchived`,
  `primaryLanguage`. `NOT_FOUND` in a batch is a deleted repository, not a
  failure.
- **Weekly**: `pnpm history --refresh` (page 1 only, with ETags).
- Build shards, `nuxt generate`, deploy, re-upload the dataset asset.

Job limit is 6 hours. The daily path is minutes; only a backfill exceeds it, and
a backfill is run by hand.

---

## Sequencing and the first checkpoint

Wave 0 → Wave 1 (A, B, C, D in parallel) → **backfill the seven lists** →
Wave 2 → **look at it** → extend to 80 → Wave 3.

The seven prototype lists are `golang, rust, nodejs, vue, selfhosted, kubernetes,
macos`. Those are the real `config.yaml` slugs — `go`, `node` and `mac` do not
exist and exit 1. Measured by `--dry-run`: 7,122 repositories (including the
eight source list repos themselves), **13,951 requests, 2.8 hours** at 14
months' depth.

They were chosen by preference but they cover the failure modes by construction,
which is why the checkpoint after Wave 2 is the real one:

| list | entries | non-GitHub | what it tests |
| --- | ---: | ---: | --- |
| go | 2,829 | 8% | worst-case density, 134 sections |
| awesome-mac | 1,278 | **49%** | curator order for unrankable rows |
| vue | 1,043 | **46%** | same, plus 119 sections |
| MacOS (both sources) | 2,095 | — | merged-list ordering: two curators, one row |
| selfhosted, rust, node, k8s | — | 10-16% | the ordinary case |

Three decisions in `DESIGN.md` are bets, and each breaks on a different list:
row density breaks on `golang`, the activity gradient breaks on a mixed list, and
curator-order-for-links breaks on `awesome-mac`. Extending to 80 lists before
looking at these three would mean discovering the second and third problems after
building on top of them.

## Notes for whoever runs the agents

- **Wave 1 tasks must not touch each other's files.** The file lists above are
  exhaustive; if a task needs something outside its list, that is a signal the
  contract in Wave 0 is wrong — fix the contract, do not reach across.
- **Give each agent `DESIGN.md`**, not a summary of it. The reasoning is what
  stops an agent from "improving" a decision that was made deliberately — the
  trend score not being rendered, `Ctrl+F` over virtualisation, tuples over
  objects.
- **Task B is the one to review closely.** It is where the site makes claims
  about other people's projects, and it is the only task whose output cannot be
  checked by looking at the screen.
