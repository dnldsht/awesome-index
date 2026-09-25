## What this is

A crawled index of awesome lists. The dataset is sqlite (`data/awesome.db`,
kept out of git and restored from a release asset in CI); the site that reads it
is being rewritten.

**Read `DESIGN.md` before changing anything, and `PLAN.md` before picking work
up.** `DESIGN.md` records the decisions and the reasoning that is not
recoverable from the code. Several of them look wrong at a glance and are
deliberate. `src/lib/contracts.ts` is the shape of everything that crosses a
boundary, and is what the parallel strands of the rewrite are written against.

The Astro presentation layer was deleted in Wave 0. There is no dev server in
the tree at the moment; the Nuxt one arrives with Wave 1 D.

## Conventions

- pnpm. Node 22+ runs the TypeScript directly; there is no build step, which is
  why imports carry their `.ts` extension.
- Drizzle over better-sqlite3. Schema changes go in `src/lib/db/schema.ts` and
  the migration is **generated** (`pnpm db:generate`), never hand-written.
- Comments explain _why_, in prose. The existing files are the house style.

## Commands

```
pnpm crawl [--help]       refresh the dataset from GitHub
pnpm popularity [--help]  rank the targets that have no stars of their own
pnpm fixtures             rebuild fixtures/ from the current dataset
pnpm db:generate          generate a migration from the schema
pnpm db:migrate           apply migrations to data/awesome.db
pnpm typecheck            tsc --noEmit
pnpm format               prettier
```
