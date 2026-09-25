# Awesome Index

**[awesome.donld.me](https://awesome.donld.me)** — 80 awesome lists, ordered by
what is actually moving.

Awesome lists are long, and the order they are written in tells you nothing
about what is alive. This crawls 80 of them into a local sqlite dataset, follows
every entry to GitHub, keeps fourteen months of weekly star history behind each
repository, and renders a list you can reorder: the curator's own order, most
stars, most recently pushed, or **climbing** — which is not the biggest gain but
the one furthest above its own normal week.

A project that usually gains three stars a week and gained forty has moved. One
that gains four hundred every week and gained four hundred has not.

## What it knows

- **47,416 entries** across 80 lists, of which **35,288 are GitHub repositories**.
- The rest — 11,491 sites, papers, videos, registries and books — carry no
  popularity signal at all, so they keep the curator's order. That is the only
  honest information anybody holds about them, and the site says so rather than
  ranking them below a three-star toy nobody has touched since 2019.
- Weekly star history per repository, used to compute 7-day, 30-day and 1-year
  movement. The history never reaches the browser; the page carries the counts.
- An activity label — active, slow, stalled, archived — computed as a percentile
  **inside each language's cohort**, because eighteen months without a commit
  means abandonment for a TypeScript package and completion for a C library.
  Measured on this corpus, the oldest quartile of a cohort begins at 239 days
  for TypeScript and 3,138 for Objective-C.

The score that produces the climbing order is deliberately never shown. An
ordering is a decision; a printed number is a claim.

## How it is put together

Nuxt, generated statically, no server. Each list is one JSON shard — the largest
is 173 KB gzipped — so the browser holds the whole list and reordering it is a
`.sort()` rather than a new page. That is the entire reason the site can offer
four orders and three windows without generating four thousand pages.

```
bin/crawl.ts      read the list READMEs, resolve every entry, refresh GitHub metadata
bin/history.ts    weekly star history, by numeric repo id so renames do not split it
bin/popularity.ts rank the targets that have no stars of their own
bin/shards.ts     build public/data/*.json from the dataset
bin/fixtures.ts   a shard to develop against without a dataset
```

The dataset is sqlite, kept out of git and carried between CI runs as a release
asset. A nightly Action crawls, takes one slice of star history, republishes the
dataset, rebuilds the shards and deploys.

## Running it

```
pnpm install
pnpm dev                  # runs against fixtures/ if there is no dataset
```

With a dataset (`GITHUB_TOKEN` needs no scopes — it only reads public data):

```
pnpm crawl --help
pnpm history --help       # --concurrency=8 for a backfill by hand
pnpm shards
pnpm generate
```

`pnpm test` · `pnpm typecheck` · `pnpm format`

## Reading the code

`DESIGN.md` records the decisions and the reasoning that is not recoverable from
the code — several of them look wrong at a glance and are deliberate.
`src/lib/contracts.ts` is the shape of everything that crosses a boundary.
`PLAN.md` is the build order.

## Credits

The lists belong to their curators; this only reads them. Star history comes
from GitHub's `/stargazers/history` endpoint, and the full curve behind an
expanded row is drawn by [star-history.com](https://star-history.com). Icons are
[Pixelarticons](https://github.com/halfmage/pixelarticons) by Gerrit Halfmann.
Type is Source Serif 4 and IBM Plex Mono.

Made with ♥ by [Donald](https://donld.me) and Opus. MIT.
