import * as D from "drizzle-orm";
import { loadConfig, type ConfigEntry } from "./config.ts";
import { db } from "./db/client.ts";
import {
  awesomeItemTable,
  githubRepoTable,
  type GithubRepo,
} from "./db/schema.ts";
import { collidesWithPagination } from "./urls.ts";

/**
 * Every route reads straight from sqlite instead of going through a content
 * collection loader. The Content Layer earns its keep when entries come from a
 * slow or remote source it can cache by digest; here the source is a local file
 * we regenerate wholesale every night, so a loader would only copy 20k rows
 * into a second store and make the build slower for no gain.
 */

export type RepoWithSections = GithubRepo & {
  /** the sections of *this* list the repo was filed under */
  sections: { path: string[]; slug: string }[];
  note: string | null;
};

/**
 * The synthetic heading that entries above every real heading are filed under.
 *
 * 1,123 awesome_item rows carry an empty `section_slug` — 1,094 of them are
 * `uhub/awesome-javascript`, which lists all of its links in the README preamble
 * and never writes a heading at all. Without a home those rows exist only on the
 * list page itself, which is exactly the thing that made capping the list page
 * impossible: cap it and they become unreachable.
 *
 * The slug is checked against the real heading slugs of the same entry on every
 * build (see `categoriesForList`) rather than assumed free. Today no list has a
 * heading that slugifies to it.
 */
export const UNCATEGORIZED_SLUG = "uncategorized";

/** the heading path the bucket renders as, in place of the `[]` on those rows */
export const UNCATEGORIZED_PATH = ["Uncategorized"];

/**
 * A stored `(section_slug, section)` pair as the site addresses it: unchanged
 * for a real heading, the bucket above for an entry that had none.
 */
export function sectionOf(slug: string, path: string[]) {
  return slug === ""
    ? { slug: UNCATEGORIZED_SLUG, path: UNCATEGORIZED_PATH }
    : { slug, path };
}

function groupSections(
  rows: {
    repo: GithubRepo;
    section: string[];
    sectionSlug: string;
    note: string | null;
    position: number;
  }[],
): RepoWithSections[] {
  const byId = new Map<string, RepoWithSections>();
  for (const row of rows) {
    let entry = byId.get(row.repo.id);
    if (!entry) {
      entry = { ...row.repo, sections: [], note: row.note };
      byId.set(row.repo.id, entry);
    }
    const section = sectionOf(row.sectionSlug, row.section);
    // two source lists merged into one entry (JavaScript is sorrycc + uhub) can
    // both file the same repo under no heading, and both collapse onto the same
    // synthetic slug; the section list is a set of pages, not of rows
    if (!entry.sections.some((s) => s.slug === section.slug)) {
      entry.sections.push(section);
    }
    // keep the first note we saw, list authors repeat the link with no prose
    entry.note ??= row.note;
  }
  return [...byId.values()];
}

/** every repository featured by a config entry, most starred first */
export async function reposForList(
  entry: ConfigEntry,
): Promise<RepoWithSections[]> {
  const rows = await db
    .select({
      repo: githubRepoTable,
      section: awesomeItemTable.section,
      sectionSlug: awesomeItemTable.sectionSlug,
      note: awesomeItemTable.note,
      position: awesomeItemTable.position,
    })
    .from(awesomeItemTable)
    .innerJoin(
      githubRepoTable,
      D.eq(githubRepoTable.id, awesomeItemTable.repoId),
    )
    .where(D.inArray(awesomeItemTable.listId, entry.sourceIds))
    .orderBy(D.desc(githubRepoTable.stars));

  return groupSections(rows);
}

export type Category = {
  /** the URL segment path, i.e. what `categoryPath()` takes */
  slug: string;
  /**
   * What `awesome_item.section_slug` actually holds — the empty string for the
   * headingless bucket, identical to `slug` otherwise. Kept separate so
   * `reposForCategory` can be handed the storage key without having to guess
   * whether "uncategorized" means the bucket or a heading someone really wrote.
   */
  sectionSlug: string;
  path: string[];
  count: number;
};

/**
 * The heading paths of a config entry, with how many repositories each holds.
 *
 * Joins github_repo rather than counting awesome_item alone: a list keeps
 * linking repositories that were since deleted or made private, and those never
 * get a github_repo row. Counting them would inflate every category and, for a
 * section whose repos are all gone, emit a category page with nothing on it.
 *
 * Rows with no heading are not dropped any more — they become the synthetic
 * `UNCATEGORIZED_SLUG` category, which is what makes them crawlable.
 */
export async function categoriesForList(
  entry: ConfigEntry,
): Promise<Category[]> {
  const count = D.sql<number>`count(distinct ${awesomeItemTable.repoId})`;
  const rows = await db
    .select({
      slug: awesomeItemTable.sectionSlug,
      section: awesomeItemTable.section,
      count,
    })
    .from(awesomeItemTable)
    .innerJoin(
      githubRepoTable,
      D.eq(githubRepoTable.id, awesomeItemTable.repoId),
    )
    .where(D.inArray(awesomeItemTable.listId, entry.sourceIds))
    .groupBy(awesomeItemTable.sectionSlug)
    .orderBy(D.desc(count));

  // Two ways a README could take a URL this site has already spoken for, both
  // of which the nightly crawl could introduce without anyone editing code, and
  // both of which fail silently — a duplicate getStaticPaths entry, or a
  // category page and a pagination page fighting over the same file.
  const written = new Set(rows.map((row) => row.slug));
  if (written.has("") && written.has(UNCATEGORIZED_SLUG)) {
    throw new Error(
      `${entry.slug}: a heading slugifies to "${UNCATEGORIZED_SLUG}", which is ` +
        `also where this list's headingless entries are filed; rename the ` +
        `bucket in queries.ts`,
    );
  }
  for (const slug of written) {
    if (collidesWithPagination(slug)) {
      throw new Error(
        `${entry.slug}: heading "${slug}" renders as /${entry.slug}/${slug}/, ` +
          `which is the URL of a paginated listing; rename PAGE_SEGMENT in urls.ts`,
      );
    }
  }

  return rows.map((row) => {
    const section = sectionOf(row.slug, row.section);
    return {
      slug: section.slug,
      sectionSlug: row.slug,
      path: section.path,
      count: row.count,
    };
  });
}

/**
 * Repositories filed under one heading path of one config entry.
 *
 * `sectionSlug` is the *stored* slug, i.e. `Category.sectionSlug` and not
 * `Category.slug`: pass `""` to get the headingless bucket the site publishes
 * at `UNCATEGORIZED_SLUG`.
 */
export async function reposForCategory(
  entry: ConfigEntry,
  sectionSlug: string,
): Promise<RepoWithSections[]> {
  const rows = await db
    .select({
      repo: githubRepoTable,
      section: awesomeItemTable.section,
      sectionSlug: awesomeItemTable.sectionSlug,
      note: awesomeItemTable.note,
      position: awesomeItemTable.position,
    })
    .from(awesomeItemTable)
    .innerJoin(
      githubRepoTable,
      D.eq(githubRepoTable.id, awesomeItemTable.repoId),
    )
    .where(
      D.and(
        D.inArray(awesomeItemTable.listId, entry.sourceIds),
        D.eq(awesomeItemTable.sectionSlug, sectionSlug),
      ),
    )
    .orderBy(D.desc(githubRepoTable.stars));

  return groupSections(rows);
}

/** one repository plus every list and section that features it */
export async function repoDetail(id: string) {
  const [repo] = await db
    .select()
    .from(githubRepoTable)
    .where(D.eq(githubRepoTable.id, id))
    .limit(1);
  if (!repo) return undefined;

  const appearances = await db
    .select({
      listId: awesomeItemTable.listId,
      section: awesomeItemTable.section,
      sectionSlug: awesomeItemTable.sectionSlug,
      note: awesomeItemTable.note,
    })
    .from(awesomeItemTable)
    .where(D.eq(awesomeItemTable.repoId, id));

  return { repo, appearances };
}

export type ListSummary = {
  entry: ConfigEntry;
  repoCount: number;
  /** most recent push across the list, i.e. how fresh the niche itself is */
  lastActivity: Date | undefined;
};

/**
 * Config entries that actually have crawled data, with their size.
 *
 * A list declared in config.yaml but never crawled has no rows, and every route
 * builds off this: emitting a page for an empty list would ship thin content
 * and put a dead link in the sitemap.
 */
export async function listSummaries(): Promise<ListSummary[]> {
  const entries = await loadConfig();
  const summaries: ListSummary[] = [];

  for (const entry of entries) {
    const [row] = await db
      .select({
        repoCount: D.sql<number>`count(distinct ${awesomeItemTable.repoId})`,
        lastActivity: D.sql<number | null>`max(${githubRepoTable.pushedAt})`,
      })
      .from(awesomeItemTable)
      .innerJoin(
        githubRepoTable,
        D.eq(githubRepoTable.id, awesomeItemTable.repoId),
      )
      .where(D.inArray(awesomeItemTable.listId, entry.sourceIds));

    if (!row || row.repoCount === 0) continue;
    summaries.push({
      entry,
      repoCount: row.repoCount,
      lastActivity: row.lastActivity
        ? new Date(row.lastActivity * 1000)
        : undefined,
    });
  }

  return summaries.sort((a, b) => b.repoCount - a.repoCount);
}

/** ids of every repository that at least one list links, for getStaticPaths */
export async function allRepoIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: githubRepoTable.id })
    .from(githubRepoTable)
    .innerJoin(
      awesomeItemTable,
      D.eq(awesomeItemTable.repoId, githubRepoTable.id),
    );
  return rows.map((row) => row.id);
}
