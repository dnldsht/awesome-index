/**
 * Fills `star_history` — weekly star deltas — from GitHub, resumably.
 *
 * Two passes:
 *
 * 1. every GitHub target that has no `database_id` yet gets one, through a
 *    GraphQL batch of 100 aliases per request. Star history is fetched by
 *    numeric id because a rename otherwise splits a repository's series in
 *    two, so this pass is a precondition rather than an optimisation. The
 *    repositories GitHub no longer serves come back `null` in the same batch
 *    and are written down as `history_fetch.gone` — free dead-repo detection.
 * 2. `GET /repositories/{id}/stargazers/history`, 30 weeks to a page, newest
 *    page first, two pages deep by default (~14 months — see `DESIGN.md`).
 *
 * The binding constraint is quota, not the network: 5,000 requests an hour,
 * and a full backfill of the corpus is ~68,750 of them. Unthrottled that burns
 * the hour in 85 seconds and then sleeps for 58 minutes, so requests are paced
 * to ~1.4/s instead and the run takes the fourteen hours it actually costs.
 * Which is why `history_fetch` exists: the run has to survive being killed at
 * hour nine and pick up where it stopped.
 *
 * The weekly refresh (`--refresh`) is the same machinery asking only for page
 * 1, with `If-None-Match`. Pages past the first are closed intervals of weeks
 * that have already happened and can never change; page 1 usually has not
 * changed either, and a 304 costs no quota at all.
 *
 * Usage: pnpm history [--only=kubernetes] [--pages=4] [--refresh] [--dry-run]
 */
import * as D from "drizzle-orm";
import { parseArgs } from "node:util";
import PQueue from "p-queue";
import { loadConfig } from "../src/lib/config.ts";
import { db } from "../src/lib/db/client.ts";
import {
  awesomeItemTable,
  historyFetchTable,
  starHistoryTable,
  targetTable,
} from "../src/lib/db/schema.ts";
import {
  fetchDatabaseIds,
  fetchHistoryPage,
  hasToken,
  plannedPages,
  quota,
  WEEKS_PER_PAGE,
} from "../src/lib/history.ts";

const { values: flags } = parseArgs({
  options: {
    only: { type: "string" },
    pages: { type: "string", default: "2" },
    refresh: { type: "boolean", default: false },
    "id-batch": { type: "string", default: "100" },
    rps: { type: "string", default: "1.4" },
    concurrency: { type: "string", default: "1" },
    "max-repos": { type: "string" },
    "skip-ids": { type: "boolean", default: false },
    "ids-only": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`pnpm history [options]

  --only=kubernetes,rust   only these config.yaml entries (default: all)
  --pages=N                weeks of history, in pages of 30 (default 2, ~14 months)
  --refresh                weekly mode: page 1 only, every repository, with ETags
  --max-repos=N            stop after N repositories (the least recently fetched first)
  --skip-ids               assume database_id is already harvested
  --ids-only               only pass 1, the numeric ids (also finds deleted repos)
  --id-batch=N             aliases per GraphQL request (default 100, the node limit)
  --rps=N                  requests per second (default 1.4; see the note on quota)
  --concurrency=N          repositories in flight at once (default 1)
  --dry-run                print the projected cost and call nothing
`);
  process.exit(0);
}

const DEPTH = Math.max(1, Number(flags.pages) || 2);
const ID_BATCH = Math.min(Number(flags["id-batch"]) || 100, 100);
const MAX_REPOS = flags["max-repos"] ? Number(flags["max-repos"]) : undefined;
const REFRESH = flags.refresh;
const DRY_RUN = flags["dry-run"];

/**
 * The gap between two requests.
 *
 * 1.4/s is 5,040 an hour, which is the authenticated budget with nothing to
 * spare — the point is not politeness, it is that going faster buys nothing
 * except a 403 and an hour of sleeping. A pool of tokens for different
 * accounts multiplies the budget, and then `--rps` is the flag that spends it.
 */
const GAP_MS = 1000 / (Number(flags.rps) || 1.4);

/*
 * How many repositories are in flight at once, and why the default is one.
 *
 * `pace()` puts a floor under the gap between requests, but requests are
 * awaited, so a single chain is capped at one round trip at a time — about 4/s
 * however high `--rps` is set. That is what concurrency is for.
 *
 * It does **not** buy a faster backfill against one token, and it is worth
 * saying why so nobody tries again. This endpoint has an hourly budget of its
 * own that `GET /rate_limit` does not report: that endpoint shows `core`
 * untouched while a backfill runs, and the 403 the backfill eventually gets
 * carries `x-ratelimit-remaining: 0` for `core` all the same. Four in flight
 * reached 238 repositories a minute, emptied the invisible budget in minutes,
 * and earned a 27-minute wait — a net loss against the steady 1.4/s that
 * spends exactly what the hour allows.
 *
 * Concurrency is therefore for the case `--rps` cannot help with on its own:
 * a pool of tokens on different accounts, where the budget is genuinely larger
 * and one chain cannot spend it fast enough.
 */
const CONCURRENCY = Math.max(1, Number(flags.concurrency) || 1);

/** sqlite caps bound parameters per statement; a page is 30 rows of 3 */
const INSERT_CHUNK = 400;

if (!DRY_RUN && !hasToken()) {
  console.error(
    "GITHUB_TOKEN is not set. Provide one token, or several comma separated " +
      "ones belonging to different accounts (the hourly quota is per account). " +
      "`GITHUB_TOKEN=$(gh auth token)` works for a run by hand.",
  );
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** the one throttle every request in this file goes through */
let lastRequestAt = 0;
async function pace() {
  const wait = lastRequestAt + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function hours(requests: number): string {
  const h = (requests * GAP_MS) / 1000 / 3600;
  return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
}

/* -------------------------------------------------------------------------- */
/* scope                                                                      */
/* -------------------------------------------------------------------------- */

type Repo = {
  id: string;
  databaseId: number | null;
  createdAt: Date | null;
  pagesDone: number;
  etagPage1: string | null;
  gone: boolean;
};

/**
 * The repositories in scope, with everything the fetcher needs about each.
 *
 * `--only` matches `bin/crawl.ts`: config entry slugs, resolved to the source
 * READMEs behind them, and then to everything those READMEs link. The source
 * lists themselves are in scope too — an awesome list is a repository with a
 * star count like any other, and the site shows it.
 *
 * The `inArray` is over source ids (87 at most) rather than over target ids
 * (7,000 for the prototype set) because the second would be a bound-parameter
 * problem for no gain; the target ids stay inside sqlite as a subquery.
 *
 * Ordered least-recently-fetched first, nulls leading, so an interrupted run
 * resumes on the work it had not reached and `--max-repos` slices a prefix
 * that means something.
 */
async function scopedRepos(): Promise<Repo[]> {
  const config = await loadConfig();
  const only = flags.only?.split(",").map((x) => x.trim().toLowerCase());

  let scope = D.eq(targetTable.kind, "github");
  if (only) {
    const unknown = only.filter((slug) => !config.some((x) => x.slug === slug));
    if (unknown.length) {
      console.error(`unknown config.yaml entries: ${unknown.join(", ")}`);
      process.exit(1);
    }
    const sourceIds = [
      ...new Set(
        config.filter((x) => only.includes(x.slug)).flatMap((x) => x.sourceIds),
      ),
    ];
    const linked = db
      .select({ id: awesomeItemTable.targetId })
      .from(awesomeItemTable)
      .where(D.inArray(awesomeItemTable.listId, sourceIds));

    scope = D.and(
      scope,
      D.or(
        D.inArray(targetTable.id, linked),
        D.inArray(targetTable.id, sourceIds),
      ),
    )!;
  }

  const rows = await db
    .select({
      id: targetTable.id,
      databaseId: targetTable.databaseId,
      createdAt: targetTable.createdAt,
      pagesDone: historyFetchTable.pagesDone,
      etagPage1: historyFetchTable.etagPage1,
      gone: historyFetchTable.gone,
      fetchedAt: historyFetchTable.fetchedAt,
    })
    .from(targetTable)
    .leftJoin(
      historyFetchTable,
      D.eq(historyFetchTable.targetId, targetTable.id),
    )
    .where(scope)
    .orderBy(D.asc(historyFetchTable.fetchedAt), D.asc(targetTable.id));

  const repos = rows.map((row) => ({
    id: row.id,
    databaseId: row.databaseId,
    createdAt: row.createdAt,
    pagesDone: row.pagesDone ?? 0,
    etagPage1: row.etagPage1,
    gone: row.gone ?? false,
  }));

  if (MAX_REPOS !== undefined && repos.length > MAX_REPOS) {
    console.log(`[scope] capped at ${MAX_REPOS} of ${repos.length}`);
    return repos.slice(0, MAX_REPOS);
  }
  return repos;
}

/* -------------------------------------------------------------------------- */
/* writes                                                                     */
/* -------------------------------------------------------------------------- */

function markGone(targetId: string) {
  if (DRY_RUN) return;
  db.insert(historyFetchTable)
    .values({ targetId, gone: true, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: historyFetchTable.targetId,
      set: { gone: true, fetchedAt: D.sql`excluded.fetched_at` },
    })
    .run();
}

/**
 * One page of weeks and the cursor that says we have it, in one transaction.
 *
 * Per page rather than per repository: a six-page repository interrupted after
 * its fourth page keeps four, and the cost of the finer granularity is a
 * transaction that was going to happen anyway.
 *
 * `total` is stored as `delta` unchanged — it is already the week's net gain,
 * not a running total, and the cumulative curve is `target.stars` walked
 * backwards through these. `pages_done` is a `max()` rather than an
 * assignment because `--refresh` writes page 1 over repositories that are two
 * pages deep and must not shorten them.
 */
function persistPage(
  targetId: string,
  page: number,
  weeks: { week: number; total: number }[],
  etag: string | null,
) {
  if (DRY_RUN) return;
  const now = new Date();

  db.transaction((tx) => {
    for (const rows of chunk(weeks, INSERT_CHUNK)) {
      tx.insert(starHistoryTable)
        .values(rows.map((w) => ({ targetId, week: w.week, delta: w.total })))
        .onConflictDoUpdate({
          target: [starHistoryTable.targetId, starHistoryTable.week],
          set: { delta: D.sql`excluded.delta` },
        })
        .run();
    }

    tx.insert(historyFetchTable)
      .values({
        targetId,
        pagesDone: page,
        etagPage1: page === 1 ? etag : null,
        fetchedAt: now,
        gone: false,
      })
      .onConflictDoUpdate({
        target: historyFetchTable.targetId,
        set: {
          pagesDone: D.sql`max(${historyFetchTable.pagesDone}, excluded.pages_done)`,
          fetchedAt: D.sql`excluded.fetched_at`,
          gone: false,
          // pages beyond the first are immutable, so they have no etag of
          // their own and must not blank out page 1's
          ...(page === 1 ? { etagPage1: D.sql`excluded.etag_page1` } : {}),
        },
      })
      .run();
  });
}

/** a 304: nothing to store, but the cursor is now fresh */
function touch(targetId: string) {
  if (DRY_RUN) return;
  db.update(historyFetchTable)
    .set({ fetchedAt: new Date() })
    .where(D.eq(historyFetchTable.targetId, targetId))
    .run();
}

function persistDatabaseIds(found: Map<string, number>) {
  if (DRY_RUN || found.size === 0) return;
  db.transaction((tx) => {
    for (const [id, databaseId] of found) {
      tx.update(targetTable)
        .set({ databaseId })
        .where(D.eq(targetTable.id, id))
        .run();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* pass 1: numeric ids                                                        */
/* -------------------------------------------------------------------------- */

async function harvestIds(repos: Repo[]) {
  const due = repos.filter((r) => r.databaseId === null && !r.gone);
  if (due.length === 0) {
    console.log("[ids] every repository already has a numeric id");
    return;
  }

  const batches = chunk(due, ID_BATCH);
  console.log(
    `[ids] ${due.length} repositories without one, ${batches.length} request(s)`,
  );
  if (DRY_RUN) return;

  let found = 0;
  let missing = 0;

  for (const [i, batch] of batches.entries()) {
    await pace();
    const result = await fetchDatabaseIds(batch.map((r) => r.id));

    persistDatabaseIds(result.found);
    for (const [id, databaseId] of result.found) {
      const repo = repos.find((r) => r.id === id);
      if (repo) repo.databaseId = databaseId;
    }
    for (const id of result.missing) {
      markGone(id);
      const repo = repos.find((r) => r.id === id);
      if (repo) repo.gone = true;
    }

    found += result.found.size;
    missing += result.missing.length;
    if ((i + 1) % 10 === 0 || i + 1 === batches.length) {
      console.log(
        `[ids] ${i + 1}/${batches.length} batches, ${found} resolved, ${missing} gone`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* pass 2: the history                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The pages still owed for one repository.
 *
 * `--refresh` is always exactly page 1: everything deeper has already happened
 * and cannot change. Otherwise it is `pagesDone + 1 … depth`, capped by what
 * the repository's age makes possible — a project four months old has one page
 * of history and asking for a second is a request spent to be told so.
 */
function pagesOwed(repo: Repo): number[] {
  if (REFRESH) return [1];
  const target = plannedPages(repo.createdAt, DEPTH);
  const owed: number[] = [];
  for (let page = repo.pagesDone + 1; page <= target; page++) owed.push(page);
  return owed;
}

async function fetchHistory(repos: Repo[]) {
  // a dry run has not harvested the ids, so it projects on the assumption that
  // pass 1 would have: otherwise the first ever run reports a cost of zero
  const live = repos.filter(
    (r) => !r.gone && (DRY_RUN || r.databaseId !== null),
  );
  const work = live
    .map((repo) => ({ repo, pages: pagesOwed(repo) }))
    .filter((x) => x.pages.length > 0);
  const projected = work.reduce((sum, x) => sum + x.pages.length, 0);

  console.log(
    `[history] ${work.length} of ${repos.length} repositories owe ` +
      `${projected} request(s), ~${hours(projected)} at ${(1000 / GAP_MS).toFixed(1)} req/s`,
  );
  if (DRY_RUN || projected === 0) return;

  const startedAt = Date.now();
  let done = 0;
  let requests = 0;
  let notModified = 0;
  let weeksStored = 0;
  let gone = 0;

  /*
   * One task per repository, N in flight. The pages of a single repository
   * stay sequential inside its task: page 2 is only worth fetching if page 1
   * did not turn out to be the last, and `persistPage` writes the cursor after
   * each one, so a run killed mid-repository resumes mid-repository.
   */
  const queue = new PQueue({ concurrency: CONCURRENCY });

  for (const { repo, pages } of work) {
    void queue.add(async () => {
      for (const page of pages) {
        // only page 1 has an ETag worth sending; the rest are immutable and
        // were never fetched twice in the first place
        const etag = page === 1 ? repo.etagPage1 : null;
        await pace();
        requests++;

        let result;
        try {
          result = await fetchHistoryPage(repo.databaseId!, page, etag);
        } catch (error: any) {
          console.warn(`[skip] ${repo.id} page ${page}: ${error?.message}`);
          break;
        }

        if (result.kind === "gone") {
          markGone(repo.id);
          gone++;
          break;
        }
        if (result.kind === "notModified") {
          // page 1 is unchanged, which says nothing about the pages behind it:
          // carry on rather than break, so a deepening run that happens to
          // start at page 1 does not stop at the first thing that did not move
          notModified++;
          touch(repo.id);
          continue;
        }

        persistPage(repo.id, page, result.weeks, result.etag);
        weeksStored += result.weeks.length;

        // the repository is younger than the depth asked for: `Link` says which
        // page is the last, and there is nothing past it to come back for
        if (result.lastPage !== null && page >= result.lastPage) break;
        if (result.weeks.length < WEEKS_PER_PAGE) break;
      }

      done++;
      if (done % 100 === 0 || done === work.length) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const left = Math.max(projected - requests, 0);
        console.log(
          `[history] ${done}/${work.length} repos, ${requests} requests ` +
            `(${notModified} unchanged), ${weeksStored} weeks, ${gone} gone, ` +
            `${Math.round(elapsed)}s elapsed, ~${hours(left)} left` +
            (Number.isFinite(quota.remaining)
              ? ` (${quota.remaining} quota left)`
              : ""),
        );
      }
    });
  }

  await queue.onIdle();

  return { requests, notModified, weeksStored, gone };
}

/* -------------------------------------------------------------------------- */

async function main() {
  const startedAt = Date.now();

  const repos = await scopedRepos();
  console.log(
    `[scope] ${repos.length} GitHub repositor(ies)` +
      (flags.only ? ` in ${flags.only}` : "") +
      (REFRESH ? ", refresh mode (page 1 only)" : `, depth ${DEPTH} page(s)`),
  );

  if (!flags["skip-ids"] && !REFRESH) await harvestIds(repos);
  else if (REFRESH) {
    const unknown = repos.filter((r) => r.databaseId === null && !r.gone);
    if (unknown.length) {
      console.log(
        `[ids] ${unknown.length} repositor(ies) have no numeric id and are ` +
          `skipped; run without --refresh to harvest them`,
      );
    }
  }

  if (!flags["ids-only"]) await fetchHistory(repos);

  console.log(
    `[done] ${Math.round((Date.now() - startedAt) / 1000)}s` +
      (DRY_RUN ? " (dry run, nothing written)" : ""),
  );
}

await main();
