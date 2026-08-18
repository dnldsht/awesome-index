/**
 * Refreshes the sqlite dataset the static site is built from.
 *
 * 1. reads every awesome list declared in config.yaml, parses its README and
 *    stores what it links *together with the heading path* — a repository, a
 *    project's own site, whatever the curator wrote (see src/lib/targets.ts)
 * 2. refreshes the metadata of the repositories among them (stars, forks,
 *    pushedAt, language, topics, license, archived) through batched GraphQL
 * 3. asks the rest whether they still answer, which is the only signal a plain
 *    URL has to give (see src/lib/liveness.ts)
 *
 * The GitHub API allows 5000 requests/hour per account (1000/hour for the
 * built-in Actions token) and the dataset holds ~20k repositories, so the
 * metadata pass goes through GraphQL where one request resolves a whole batch.
 * A full refresh costs ~250 requests / ~1300 rate limit points.
 *
 * Pass 3 talks to a few thousand third-party hosts instead, so it is spread by
 * `--link-stale-days` rather than run whole every night, and it never sends two
 * requests to the same host at once.
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
  targetTable,
} from "../src/lib/db/schema.ts";
import {
  fetchAwesomeList,
  fetchGithubProjects,
  resetOctokitRotation,
  rotateOctokit,
  type GithubProject,
} from "../src/lib/github.ts";
import { applyProbe, probeLink } from "../src/lib/liveness.ts";
import type { ParsedItem } from "../src/lib/readme.ts";
import {
  targetHost,
  targetUrl,
  type ResolvedTarget,
} from "../src/lib/targets.ts";

const { values: flags } = parseArgs({
  options: {
    only: { type: "string" },
    "batch-size": { type: "string", default: "50" },
    // 8 reliably trips the GraphQL secondary limit on a warm cache
    concurrency: { type: "string", default: "4" },
    "stale-days": { type: "string" },
    "max-repos": { type: "string" },
    "link-stale-days": { type: "string", default: "7" },
    "max-links": { type: "string" },
    "skip-readme": { type: "boolean", default: false },
    "skip-links": { type: "boolean", default: false },
    "links-only": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`pnpm crawl [options]

  --only=rust,golang     only crawl these config.yaml entries (default: all)
  --stale-days=N         skip repositories refreshed less than N days ago
  --max-repos=N          stop after N repositories (the stalest ones first)
  --batch-size=N         repositories per GraphQL request (default 50, max 100)
  --concurrency=N        parallel requests (default 4, higher trips secondary limits)
  --link-stale-days=N    skip links checked less than N days ago (default 7)
  --max-links=N          stop after N link checks (the stalest ones first)
  --skip-readme          reuse the list contents already in the database
  --skip-links           do not check whether the links off GitHub still answer
  --links-only           only pass 3, the reachability check (needs no token)
  --dry-run              fetch everything but write nothing
`);
  process.exit(0);
}

const BATCH_SIZE = Math.min(Number(flags["batch-size"]) || 50, 100);
const CONCURRENCY = Number(flags.concurrency) || 8;
const STALE_DAYS = flags["stale-days"]
  ? Number(flags["stale-days"])
  : undefined;
const MAX_REPOS = flags["max-repos"] ? Number(flags["max-repos"]) : undefined;
const LINK_STALE_DAYS = Number(flags["link-stale-days"]) || 0;
const MAX_LINKS = flags["max-links"] ? Number(flags["max-links"]) : undefined;
const DRY_RUN = flags["dry-run"];

/**
 * How many hosts are probed at once in pass 3. Each host is a queue of one, so
 * this is also the promise that no site sees two requests from us in parallel;
 * the ceiling that matters is our own outbound sockets, not anybody's patience.
 */
const LINK_CONCURRENCY = 12;

/** breathing room between two requests to the *same* host */
const HOST_GAP_MS = 500;

/** sqlite caps bound parameters per statement, so wide inserts have to chunk */
const INSERT_CHUNK = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

// pass 3 talks to nobody's API, so a link-only run has nothing to authenticate
if (!flags["links-only"] && !process.env["GITHUB_TOKEN"]) {
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

/**
 * Replaces a list's items in one transaction, so a crash never half-writes it.
 *
 * The targets that are not repositories are written here too, with nothing on
 * them but their address: there is no API to ask about a website, so a row that
 * only the parser can create is the row we have, and pass 3 fills in whether it
 * still answers. A repository gets its row from the GraphQL pass instead, and
 * that asymmetry is the mechanism that drops repositories GitHub no longer
 * serves — no row means no metadata means it never reaches the site.
 *
 * On a target that already exists only the address is refreshed: `status`,
 * `failStreak` and the dates belong to the reachability pass and would be
 * thrown away by an upsert that touched them.
 */
function persistList(id: string, readmeDigest: string, items: ParsedItem[]) {
  if (DRY_RUN) return;
  const now = new Date();

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
        .values(
          rows.map((item) => ({
            listId: id,
            targetId: item.target.id,
            section: item.section,
            sectionSlug: item.sectionSlug,
            title: item.title,
            note: item.note,
            position: item.position,
          })),
        )
        .run();
    }

    const links = [
      ...new Map(
        items
          .filter((item) => item.target.kind !== "github")
          .map((item) => [item.target.id, item.target]),
      ).values(),
    ];

    for (const rows of chunk(links, INSERT_CHUNK)) {
      tx.insert(targetTable)
        .values(
          rows.map((target) => ({
            id: target.id,
            kind: target.kind,
            url: target.url,
            refreshedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: targetTable.id,
          set: {
            url: D.sql`excluded.url`,
            refreshedAt: D.sql`excluded.refreshed_at`,
          },
        })
        .run();
    }
  });
}

/** refreshes the README of every list and returns everything they link */
async function crawlAwesomeLists(
  sourceIds: string[],
): Promise<ResolvedTarget[]> {
  const stored = await db
    .select({
      id: awesomeListTable.id,
      digest: awesomeListTable.readmeDigest,
    })
    .from(awesomeListTable)
    .where(D.inArray(awesomeListTable.id, sourceIds));
  const digestById = new Map(stored.map((x) => [x.id, x.digest]));

  /**
   * The targets a set of lists already has stored, for the two paths that do not
   * parse a README: `--skip-readme`, and a list whose README we could not fetch.
   *
   * A linked target with no `target` row of its own has never been fetched, and
   * the github provider is the only one that leaves row creation to its fetch
   * (see `persistList`), so that is what it is.
   */
  const storedTargets = async (ids: string[]): Promise<ResolvedTarget[]> => {
    const rows = await db
      .selectDistinct({
        id: awesomeItemTable.targetId,
        kind: targetTable.kind,
        url: targetTable.url,
      })
      .from(awesomeItemTable)
      .leftJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
      .where(D.inArray(awesomeItemTable.listId, ids));

    return rows.map((row) => {
      const kind = row.kind ?? "github";
      return { kind, id: row.id, url: row.url ?? targetUrl(kind, row.id) };
    });
  };

  if (flags["skip-readme"]) {
    const targets = await storedTargets(sourceIds);
    console.log(`[lists] reusing ${targets.length} stored target(s)`);
    return targets;
  }

  const queue = new PQueue({ concurrency: CONCURRENCY });
  const targets = new Map<string, ResolvedTarget>();
  let unchanged = 0;
  let parsed = 0;
  let links = 0;

  await queue.addAll(
    sourceIds.map((id) => async () => {
      const result = await withRetry(id, () => fetchAwesomeList(id));

      if (!result) {
        for (const target of await storedTargets([id])) {
          targets.set(target.id, target);
        }
        console.warn(`[lists] ${id}: unreachable, keeping stored items`);
        return;
      }

      for (const item of result.items) {
        targets.set(item.target.id, item.target);
        if (item.target.kind !== "github") links++;
      }
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
      `${parsed} entr(ies) parsed, ${links} of them off GitHub`,
  );
  return [...targets.values()];
}

/** drops repositories refreshed recently and orders the rest stalest first */
async function selectTargets(ids: string[]) {
  const rows = await db
    .select({
      id: targetTable.id,
      refreshedAt: targetTable.refreshedAt,
    })
    .from(targetTable)
    .where(D.eq(targetTable.kind, "github"));
  const seenAt = new Map(
    rows.map((x) => [x.id, x.refreshedAt?.getTime() ?? 0]),
  );

  let targets = ids;
  if (STALE_DAYS !== undefined) {
    const cutoff = Date.now() - STALE_DAYS * DAY_MS;
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
  const rows = [...projects.values()].map((p) => ({
    id: p.id,
    kind: "github" as const,
    url: targetUrl("github", p.id),
    description: p.description,
    homepageUrl: p.homepageUrl,
    topics: p.topics,
    ownerLogin: p.ownerLogin,
    ownerAvatarUrl: p.ownerAvatarUrl,
    stars: p.stars,
    forks: p.forks,
    license: p.license,
    primaryLanguage: p.primaryLanguage || null,
    archived: p.archived,
    // the provider's own word for it is `pushedAt`; the column is the general
    // one, so that a registry provider's newest release can sit in it later
    lastActivityAt: p.pushedAt,
    createdAt: p.createdAt,
    refreshedAt,
  }));

  for (const batch of chunk(rows, INSERT_CHUNK)) {
    db.insert(targetTable)
      .values(batch)
      .onConflictDoUpdate({
        target: targetTable.id,
        set: {
          kind: D.sql`excluded.kind`,
          url: D.sql`excluded.url`,
          description: D.sql`excluded.description`,
          homepageUrl: D.sql`excluded.homepage_url`,
          topics: D.sql`excluded.topics`,
          ownerLogin: D.sql`excluded.owner_login`,
          ownerAvatarUrl: D.sql`excluded.owner_avatar_url`,
          stars: D.sql`excluded.stars`,
          forks: D.sql`excluded.forks`,
          license: D.sql`excluded.license`,
          primaryLanguage: D.sql`excluded.primary_language`,
          archived: D.sql`excluded.archived`,
          lastActivityAt: D.sql`excluded.last_activity_at`,
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

/* -------------------------------------------------------------------------- */
/* pass 3: does it still answer?                                              */
/* -------------------------------------------------------------------------- */

type LinkRow = {
  id: string;
  url: string;
  status: "ok" | "dead" | null;
  failStreak: number;
};

/**
 * The links due a check: never checked first, then longest ago first, capped.
 *
 * `--link-stale-days` is what keeps this from being 5,000 requests every night.
 * At the default of 7 a nightly run checks the seventh of the set that is oldest,
 * which is both politer to a few thousand third parties and enough: a domain
 * that lapsed on Tuesday does not need to be noticed by Wednesday.
 */
async function selectLinks(ids: string[]): Promise<LinkRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: targetTable.id,
      url: targetTable.url,
      status: targetTable.status,
      failStreak: targetTable.failStreak,
      checkedAt: targetTable.checkedAt,
    })
    .from(targetTable)
    .where(
      D.and(D.ne(targetTable.kind, "github"), D.inArray(targetTable.id, ids)),
    );

  const cutoff = Date.now() - LINK_STALE_DAYS * DAY_MS;
  const due = rows.filter((row) => (row.checkedAt?.getTime() ?? 0) < cutoff);
  due.sort(
    (a, b) => (a.checkedAt?.getTime() ?? 0) - (b.checkedAt?.getTime() ?? 0),
  );

  if (LINK_STALE_DAYS > 0) {
    console.log(
      `[links] ${rows.length - due.length} checked less than ${LINK_STALE_DAYS}d ago, skipped`,
    );
  }
  if (MAX_LINKS !== undefined && due.length > MAX_LINKS) {
    console.log(`[links] capped at ${MAX_LINKS} of ${due.length}`);
    return due.slice(0, MAX_LINKS);
  }
  return due;
}

function persistProbes(
  updates: {
    id: string;
    status: "ok" | "dead" | null;
    checkedAt: Date;
    lastOkAt?: Date;
    failStreak: number;
  }[],
) {
  if (DRY_RUN || updates.length === 0) return;
  db.transaction((tx) => {
    for (const update of updates) {
      tx.update(targetTable)
        .set({
          status: update.status,
          checkedAt: update.checkedAt,
          failStreak: update.failStreak,
          // left alone when the link did not answer: it is the last time it
          // *did*, which is exactly what a dead row has to keep
          ...(update.lastOkAt ? { lastOkAt: update.lastOkAt } : {}),
        })
        .where(D.eq(targetTable.id, update.id))
        .run();
    }
  });
}

/**
 * Checks the links, one host at a time.
 *
 * Grouped by host rather than thrown at a queue flat: awesome-go alone lists 65
 * meetup.com pages, and 65 parallel requests to one host is the behaviour that
 * gets a crawler blocked, quite reasonably. Each host is walked sequentially with
 * a gap between requests, and it is the *hosts* that run in parallel — which for
 * a set of a few thousand mostly-distinct domains is nearly as fast and rude to
 * nobody.
 */
async function checkLinks(links: LinkRow[]) {
  const byHost = new Map<string, LinkRow[]>();
  for (const link of links) {
    const host = targetHost(link.url) || link.id;
    const group = byHost.get(host) ?? [];
    group.push(link);
    byHost.set(host, group);
  }

  const queue = new PQueue({ concurrency: LINK_CONCURRENCY });
  const tally = { ok: 0, dead: 0, unknown: 0, newlyDead: 0 };
  let done = 0;

  await queue.addAll(
    [...byHost.values()].map((group) => async () => {
      const updates: Parameters<typeof persistProbes>[0] = [];

      for (const [index, link] of group.entries()) {
        if (index > 0) await sleep(HOST_GAP_MS);
        const probe = await probeLink(link.url);
        const update = applyProbe(probe, link, new Date());
        const reason =
          probe.outcome === "ok" ? String(probe.status) : probe.reason;

        tally[probe.outcome]++;
        if (update.status === "dead" && link.status !== "dead") {
          tally.newlyDead++;
          console.log(`[links] dead: ${link.url} (${reason})`);
        }
        updates.push({ id: link.id, ...update });
        done++;
      }

      persistProbes(updates);
      if (done % 250 < group.length) {
        console.log(`[links] ${done}/${links.length} checked`);
      }
    }),
  );

  return tally;
}

/** every link the configured lists point at, read from the last parse */
async function storedLinkIds(sourceIds: string[]): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: awesomeItemTable.targetId })
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .where(
      D.and(
        D.inArray(awesomeItemTable.listId, sourceIds),
        D.ne(targetTable.kind, "github"),
      ),
    );
  return rows.map((row) => row.id);
}

async function main() {
  const startedAt = Date.now();

  const sourceIds = await collectSources();
  console.log(`[lists] ${sourceIds.length} awesome list(s) from config.yaml`);

  /*
   * The reachability pass on its own, over what the last parse stored.
   *
   * It is the one pass that needs no token and touches no GitHub API, and it is
   * also the slowest wall-clock, so being able to run it alone — after a crawl,
   * or on a schedule of its own — is worth a flag.
   */
  if (flags["links-only"]) {
    const due = await selectLinks(await storedLinkIds(sourceIds));
    if (due.length === 0) {
      console.log("[links] nothing to check");
    } else {
      console.log(`[links] checking ${due.length} link(s)`);
      const tally = await checkLinks(due);
      console.log(
        `[links] ${tally.ok} answered, ${tally.dead} failed hard, ` +
          `${tally.unknown} unclear, ${tally.newlyDead} newly marked dead`,
      );
    }
    console.log(
      `[done] ${Math.round((Date.now() - startedAt) / 1000)}s` +
        (DRY_RUN ? " (dry run, nothing written)" : ""),
    );
    return;
  }

  const linked = await crawlAwesomeLists(sourceIds);
  const repoIds = [
    ...new Set([
      ...sourceIds,
      ...linked
        .filter((target) => target.kind === "github")
        .map((target) => target.id),
    ]),
  ];
  const linkIds = linked
    .filter((target) => target.kind !== "github")
    .map((target) => target.id);
  console.log(
    `[repos] ${repoIds.length} unique repositories linked` +
      (linkIds.length ? `, ${linkIds.length} other target(s)` : ""),
  );

  const targets = await selectTargets(repoIds);
  if (targets.length === 0) {
    console.log("[repos] nothing to refresh");
  } else {
    const { updated, missing } = await crawlRepos(targets);
    console.log(`[repos] ${updated} refreshed, ${missing} gone`);
  }

  let links = { ok: 0, dead: 0, unknown: 0, newlyDead: 0 };
  if (!flags["skip-links"]) {
    const due = await selectLinks(linkIds);
    if (due.length === 0) {
      console.log("[links] nothing to check");
    } else {
      console.log(`[links] checking ${due.length} link(s)`);
      links = await checkLinks(due);
      console.log(
        `[links] ${links.ok} answered, ${links.dead} failed hard, ` +
          `${links.unknown} unclear, ${links.newlyDead} newly marked dead`,
      );
    }
  }

  console.log(
    `[done] ${Math.round((Date.now() - startedAt) / 1000)}s` +
      (DRY_RUN ? " (dry run, nothing written)" : ""),
  );
}

await main();
