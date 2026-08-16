import * as D from "drizzle-orm";
import type { ConfigEntry } from "./config.ts";
import { db } from "./db/client.ts";
import {
  awesomeItemTable,
  githubRepoTable,
  type GithubRepo,
} from "./db/schema.ts";

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
    entry.sections.push({ path: row.section, slug: row.sectionSlug });
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
  slug: string;
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

  return rows
    .filter((row) => row.slug !== "")
    .map((row) => ({ slug: row.slug, path: row.section, count: row.count }));
}

/** repositories filed under one heading path of one config entry */
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
