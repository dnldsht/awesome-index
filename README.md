# Awesome Index

A static, search-engine-first explorer for GitHub's awesome lists. Every list is
crawled into a local sqlite dataset, and the site is rendered from it ahead of
time so the content is in the HTML rather than behind a client-side fetch.

## How it works

```
config.yaml  ──►  bin/crawl.ts  ──►  data/awesome.db  ──►  astro build  ──►  dist/
                  (GitHub API)        (sqlite)                              (+ pagefind)
```

1. `config.yaml` declares the awesome lists to feature. An entry can merge
   several source repositories into one page.
2. `bin/crawl.ts` reads each list's README, extracts the repositories it links
   **together with the heading path they sit under**, then refreshes the
   metadata of those repositories through batched GraphQL.
3. Routes query sqlite directly at build time and emit static HTML.

Every figure on the site — stars, forks, and especially last activity
(`pushedAt`) — is a snapshot from the last crawl. Nothing is fetched from GitHub
at runtime.

### Why the heading path matters

The dataset does not just record *that* `hyperium/hyper` is in awesome-rust, but
that it sits under `Network programming › HTTP`. That hierarchy is what category
pages are built from, and it is the difference between a few dozen indexable
pages and a few thousand.

## Commands

| Command | Action |
| :------ | :----- |
| `pnpm dev` | dev server on localhost:4321 |
| `pnpm build` | static build to `dist/`, then the pagefind index |
| `pnpm check` | Astro + TypeScript diagnostics |
| `pnpm db:generate` | write a migration from `src/lib/db/schema.ts` |
| `pnpm db:migrate` | apply migrations to `data/awesome.db` |
| `pnpm crawl` | refresh the dataset (`--help` for options) |

## Refreshing the dataset

```bash
pnpm install
pnpm db:migrate                 # create/upgrade data/awesome.db
GITHUB_TOKEN=… pnpm crawl       # refresh
pnpm build
```

`pnpm crawl --help` lists the options (`--only`, `--stale-days`, `--max-repos`,
…). A full refresh covers ~20k repositories in ~250 GraphQL requests, well
inside the hourly quota.

`GITHUB_TOKEN` accepts several comma separated tokens, but they only add budget
if they belong to *different* accounts — the 5000 requests/hour limit is per
account, not per token.

Unchanged lists are detected by their README blob sha and skipped, and
`--stale-days` keeps a daily run from re-fetching repositories it just saw.

## Notes

- `data/` is not tracked; CI restores it from a release asset between runs.
- TypeScript is pinned to 6.x: `astro check` cannot run on the 7.x native
  compiler yet ([withastro/roadmap#1321](https://github.com/withastro/roadmap/discussions/1321)).
- The crawler runs on Node's native TypeScript support, so there is no build
  step and no `tsx`.
