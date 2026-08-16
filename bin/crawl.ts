/**
 * Refreshes the sqlite dataset the static site is built from.
 *
 * 1. reads every awesome list declared in config.yaml, parses its README and
 *    stores the repositories it links *together with their heading path*
 * 2. refreshes the metadata of those repositories (stars, forks, pushedAt,
 *    language, topics, license, archived) through batched GraphQL
 *
 * The GitHub API allows 5000 requests/hour per account (1000/hour for the
 * built-in Actions token) and the dataset holds ~20k repositories, so the
 * metadata pass goes through GraphQL where one request resolves a whole batch.
 * A full refresh costs ~250 requests / ~1300 rate limit points.
 *
 * Usage: pnpm crawl [--only=rust,golang] [--stale-days=7] [--max-repos=5000]
 */
import * as D from "drizzle-orm";
import { parseArgs } from "node:util";
import PQueue from "p-queue";
import { loadConfig } from "../src/lib/config.ts";
import { db } from "../src/lib/db/client.ts";
import {
  awesomeItemTable,
  awesomeListTable,
  githubRepoTable,
} from "../src/lib/db/schema.ts";
import {
  fetchAwesomeList,
  fetchGithubProjects,
  resetOctokitRotation,
  rotateOctokit,
  type GithubProject,
} from "../src/lib/github.ts";
import type { ParsedItem } from "../src/lib/readme.ts";

const { values: flags } = parseArgs({
  options: {
    only: { type: "string" },
    "batch-size": { type: "string", default: "50" },
    // 8 reliably trips the GraphQL secondary limit on a warm cache
    concurrency: { type: "string", default: "4" },
    "stale-days": { type: "string" },
    "max-repos": { type: "string" },
    "skip-readme": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`pnpm crawl [options]

  --only=rust,golang   only crawl these config.yaml entries (default: all)
  --stale-days=N       skip repositories refreshed less than N days ago
  --max-repos=N        stop after N repositories (the stalest ones first)
  --batch-size=N       repositories per GraphQL request (default 50, max 100)
  --concurrency=N      parallel requests (default 4, higher trips secondary limits)
  --skip-readme        reuse the list contents already in the database
  --dry-run            fetch everything but write nothing
`);
  process.exit(0);
}

const BATCH_SIZE = Math.min(Number(flags["batch-size"]) || 50, 100);
const CONCURRENCY = Number(flags.concurrency) || 8;
const STALE_DAYS = flags["stale-days"]
  ? Number(flags["stale-days"])
  : undefined;
const MAX_REPOS = flags["max-repos"] ? Number(flags["max-repos"]) : undefined;
const DRY_RUN = flags["dry-run"];

/** sqlite caps bound parameters per statement, so wide inserts have to chunk */
const INSERT_CHUNK = 400;

if (!process.env["GITHUB_TOKEN"]) {
  console.error(
    "GITHUB_TOKEN is not set. Provide one token, or several comma separated " +
      "ones belonging to different accounts (the hourly quota is per account).",
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

/**
 * Retries around the two failure modes of a long crawl: rate limits (rotate to
 * the next token, or wait for the window to reset) and transient 5xx/network
 * errors. Anything permanently gone resolves to undefined so the crawl goes on.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status;
      if (status === 404 || status === 451) return undefined;

      if (status === 403 || status === 429) {
        // Secondary limits fire on burst rate, not on budget: they arrive with
        // points still on the clock and a retry-after telling us exactly how
        // long to back off. Rotating tokens does not help, the limit is on us.
        const retryAfter = Number(error?.response?.headers?.["retry-after"]);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          console.warn(`[secondary limit] ${label}: waiting ${retryAfter}s`);
          await sleep(retryAfter * 1000 + 1_000);
          continue;
        }

        if (rotateOctokit()) continue;
        const reset = Number(error?.response?.headers?.["x-ratelimit-reset"]);
        const waitMs = Number.isFinite(reset)
          ? Math.max(reset * 1000 - Date.now(), 0) + 5_000
          : attempt * 60_000;
        const capped = Math.min(waitMs, 65 * 60_000);
        console.warn(
          `[rate limit] ${label}: waiting ${Math.round(capped / 1000)}s`,
        );
        await sleep(capped);
        resetOctokitRotation();
        continue;
      }

      if (attempt >= 4) {
        console.warn(`[skip] ${label}: ${error?.message ?? error}`);
        return undefined;
      }
      await sleep(attempt * 2_000);
    }
  }
}

async function collectSources() {
  const config = await loadConfig();
  const only = flags.only?.split(",").map((x) => x.trim().toLowerCase());

  if (only) {
    const unknown = only.filter((slug) => !config.some((x) => x.slug === slug));
    if (unknown.length) {
      console.error(`unknown config.yaml entries: ${unknown.join(", ")}`);
      process.exit(1);
    }
  }

  const entries = only ? config.filter((x) => only.includes(x.slug)) : config;
  return [...new Set(entries.flatMap((x) => x.sourceIds))];
}

/** replaces a list's items in one transaction, so a crash never half-writes it */
function persistList(id: string, readmeDigest: string, items: ParsedItem[]) {
  if (DRY_RUN) return;
  db.transaction((tx) => {
    tx.insert(awesomeListTable)
      .values({ id, readmeDigest })
      .onConflictDoUpdate({
        target: awesomeListTable.id,
        set: {
          readmeDigest: D.sql`excluded.readme_digest`,
          updatedAt: new Date(),
        },
      })
      .run();

    tx.delete(awesomeItemTable).where(D.eq(awesomeItemTable.listId, id)).run();

    for (const rows of chunk(items, INSERT_CHUNK)) {
      tx.insert(awesomeItemTable)
        .values(rows.map((item) => ({ listId: id, ...item })))
        .run();
    }
  });
}

/** refreshes the README of every list and returns the repositories they link */
async function crawlAwesomeLists(sourceIds: string[]) {
  const stored = await db
    .select({
      id: awesomeListTable.id,
      digest: awesomeListTable.readmeDigest,
    })
    .from(awesomeListTable)
    .where(D.inArray(awesomeListTable.id, sourceIds));
  const digestById = new Map(stored.map((x) => [x.id, x.digest]));

  if (flags["skip-readme"]) {
    const rows = await db
      .select({ repoId: awesomeItemTable.repoId })
      .from(awesomeItemTable)
      .where(D.inArray(awesomeItemTable.listId, sourceIds));
    console.log(`[lists] reusing ${rows.length} stored item(s)`);
    return [...new Set(rows.map((x) => x.repoId))];
  }

  const queue = new PQueue({ concurrency: CONCURRENCY });
  const repoIds = new Set<string>();
  let unchanged = 0;
  let parsed = 0;

  await queue.addAll(
    sourceIds.map((id) => async () => {
      const result = await withRetry(id, () => fetchAwesomeList(id));

      if (!result) {
        const rows = await db
          .select({ repoId: awesomeItemTable.repoId })
          .from(awesomeItemTable)
          .where(D.eq(awesomeItemTable.listId, id));
        for (const row of rows) repoIds.add(row.repoId);
        console.warn(`[lists] ${id}: unreachable, keeping stored items`);
        return;
      }

      for (const item of result.items) repoIds.add(item.repoId);
      parsed += result.items.length;

      // the digest is the README blob sha: same sha, same parse result
      if (digestById.get(id) === result.readmeDigest) {
        unchanged++;
        return;
      }
      persistList(id, result.readmeDigest, result.items);
    }),
  );

  console.log(
    `[lists] ${sourceIds.length} list(s) read, ${unchanged} unchanged, ` +
      `${parsed} link(s) parsed`,
  );
  return [...repoIds];
}

/** drops repositories refreshed recently and orders the rest stalest first */
async function selectTargets(ids: string[]) {
  const rows = await db
    .select({
      id: githubRepoTable.id,
      refreshedAt: githubRepoTable.refreshedAt,
    })
    .from(githubRepoTable);
  const seenAt = new Map(
    rows.map((x) => [x.id, x.refreshedAt?.getTime() ?? 0]),
  );

  let targets = ids;
  if (STALE_DAYS !== undefined) {
    const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
    targets = targets.filter((id) => (seenAt.get(id) ?? 0) < cutoff);
    console.log(
      `[repos] ${ids.length - targets.length} refreshed less than ${STALE_DAYS}d ago, skipped`,
    );
  }
  // never seen (0) first, then oldest refresh first
  targets = targets.toSorted(
    (a, b) => (seenAt.get(a) ?? 0) - (seenAt.get(b) ?? 0),
  );

  if (MAX_REPOS !== undefined && targets.length > MAX_REPOS) {
    console.log(`[repos] capped at ${MAX_REPOS} of ${targets.length}`);
    targets = targets.slice(0, MAX_REPOS);
  }
  return targets;
}

function persistProjects(projects: Map<string, GithubProject>) {
  if (DRY_RUN || projects.size === 0) return;
  const refreshedAt = new Date();
  const rows = [...projects.values()].map((p) => ({ ...p, refreshedAt }));

  for (const batch of chunk(rows, INSERT_CHUNK)) {
    db.insert(githubRepoTable)
      .values(batch)
      .onConflictDoUpdate({
        target: githubRepoTable.id,
        set: {
          description: D.sql`excluded.description`,
          topics: D.sql`excluded.topics`,
          ownerLogin: D.sql`excluded.owner_login`,
          ownerAvatarUrl: D.sql`excluded.owner_avatar_url`,
          stars: D.sql`excluded.stars`,
          forks: D.sql`excluded.forks`,
          license: D.sql`excluded.license`,
          primaryLanguage: D.sql`excluded.primary_language`,
          archived: D.sql`excluded.archived`,
          pushedAt: D.sql`excluded.pushed_at`,
          createdAt: D.sql`excluded.created_at`,
          refreshedAt: D.sql`excluded.refreshed_at`,
        },
      })
      .run();
  }
}

async function crawlRepos(ids: string[]) {
  const batches = chunk(ids, BATCH_SIZE);
  const queue = new PQueue({ concurrency: CONCURRENCY });
  let done = 0;
  let updated = 0;
  let missing = 0;

  await queue.addAll(
    batches.map((batch, i) => async () => {
      const result = await withRetry(`batch ${i}`, () =>
        fetchGithubProjects(batch),
      );
      done++;
      if (!result) return;

      persistProjects(result.projects);
      updated += result.projects.size;
      missing += result.missing.length;

      const { rateLimit } = result;
      if (done % 10 === 0 || done === batches.length) {
        console.log(
          `[repos] ${done}/${batches.length} batches, ${updated} updated, ` +
            `${missing} gone` +
            (rateLimit ? ` (${rateLimit.remaining} points left)` : ""),
        );
      }

      // stay clear of the window rather than burning into a hard 403
      if (rateLimit && rateLimit.remaining < rateLimit.cost * 3) {
        if (!rotateOctokit()) {
          const waitMs = new Date(rateLimit.resetAt).getTime() - Date.now();
          console.warn(
            `[rate limit] budget exhausted, waiting ${Math.round(waitMs / 1000)}s`,
          );
          await sleep(Math.min(Math.max(waitMs, 0) + 5_000, 65 * 60_000));
          resetOctokitRotation();
        }
      }
    }),
  );

  return { updated, missing };
}

async function main() {
  const startedAt = Date.now();

  const sourceIds = await collectSources();
  console.log(`[lists] ${sourceIds.length} awesome list(s) from config.yaml`);

  const linked = await crawlAwesomeLists(sourceIds);
  const candidates = [...new Set([...sourceIds, ...linked])];
  console.log(`[repos] ${candidates.length} unique repositories linked`);

  const targets = await selectTargets(candidates);
  if (targets.length === 0) {
    console.log("[repos] nothing to refresh");
    return;
  }

  const { updated, missing } = await crawlRepos(targets);
  console.log(
    `[done] ${updated} repositories refreshed, ${missing} gone, ` +
      `${Math.round((Date.now() - startedAt) / 1000)}s` +
      (DRY_RUN ? " (dry run, nothing written)" : ""),
  );
}

await main();
