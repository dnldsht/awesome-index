import * as D from "drizzle-orm";
import { loadConfig, type ConfigEntry } from "./config.ts";
import { pulseBreakdown, type PulseBreakdown } from "./format.ts";
import { db } from "./db/client.ts";
import { awesomeItemTable, targetTable, type Target } from "./db/schema.ts";
import { collidesWithPagination } from "./urls.ts";

/**
 * Every route reads straight from sqlite instead of going through a content
 * collection loader. The Content Layer earns its keep when entries come from a
 * slow or remote source it can cache by digest; here the source is a local file
 * we regenerate wholesale every night, so a loader would only copy 20k rows
 * into a second store and make the build slower for no gain.
 */

export type TargetWithSections = Target & {
  /** the sections of *this* list the target was filed under */
  sections: { path: string[]; slug: string }[];
  /** what the curator calls it, which is the only name a `web` row has */
  title: string | null;
  note: string | null;
};

/**
 * What a row is ranked by when a list is ordered by popularity.
 *
 * `stars` where there are stars, and the star equivalent of some other evidence
 * where there are not: a crate's downloads, a Codeberg project's own stars, the
 * stars of the repository behind a project's website. `popularity` holds that
 * equivalent already calibrated onto the star scale, so the two coalesce into
 * one comparable number — see src/lib/popularity.ts for why that is defensible.
 *
 * No row has both today — `popularity` is only ever written to rows that have no
 * stars — so the order of the two arguments decides nothing yet. It is stated
 * anyway, and this way round: the measured figure outranks the derived one, so if
 * a provider ever gains both the coalesce does not silently start preferring a
 * translation over a count.
 */
const RANK = D.sql`coalesce(${targetTable.stars}, ${targetTable.popularity})`;

/**
 * The order a listing is in, which the list chooses (see `ListOrder`).
 *
 * Ranked first, then the rows that could not be ranked at all, in the order the
 * README writes them. `nulls last` is the whole rule, and it survives the
 * popularity column: a row we have no evidence for cannot be ranked against one
 * we do, and putting it anywhere inside the ranking would be inventing a
 * position for it. After the ranking, in the curator's own order, is the one
 * place that claims nothing — the rows land on the last page of a multi-page
 * listing together, and a reader who has scrolled that far is looking at "and
 * these, which we cannot rank" rather than at a suspiciously unstarred stretch
 * of the top 60.
 *
 * Editorial order has one wrinkle a single-source list does not: a merged entry
 * (JavaScript is sorrycc + uhub) holds two `position` values for the same row and
 * neither is *the* position. Source order decides, in the order config.yaml
 * writes the urls, so the first list's sequence runs whole before the second's
 * begins — which is what a reader comparing the page against the README expects,
 * and the only rule that does not interleave two curators' judgements into an
 * order neither of them wrote.
 */
function listingOrder(entry: ConfigEntry) {
  if (entry.sort === "editorial") {
    return [
      D.sql`case ${awesomeItemTable.listId} ${D.sql.join(
        entry.sourceIds.map((id, index) => D.sql`when ${id} then ${index}`),
        D.sql` `,
      )} else ${entry.sourceIds.length} end`,
      D.asc(awesomeItemTable.position),
    ];
  }
  return [D.sql`${RANK} desc nulls last`, D.asc(awesomeItemTable.position)];
}

/**
 * The synthetic heading that entries above every real heading are filed under.
 *
 * 1,123 awesome_item rows carry an empty `section_slug`, and 1,094 of them are
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
    target: Target;
    section: string[];
    sectionSlug: string;
    title: string | null;
    note: string | null;
    position: number;
  }[],
): TargetWithSections[] {
  const byId = new Map<string, TargetWithSections>();
  for (const row of rows) {
    let entry = byId.get(row.target.id);
    if (!entry) {
      entry = {
        ...row.target,
        sections: [],
        title: row.title,
        note: row.note,
      };
      byId.set(row.target.id, entry);
    }
    const section = sectionOf(row.sectionSlug, row.section);
    // two source lists merged into one entry (JavaScript is sorrycc + uhub) can
    // both file the same target under no heading, and both collapse onto the same
    // synthetic slug; the section list is a set of pages, not of rows
    if (!entry.sections.some((s) => s.slug === section.slug)) {
      entry.sections.push(section);
    }
    // keep the first note and title we saw, list authors repeat the link with
    // no prose and two lists may name the same thing differently
    entry.title ??= row.title;
    entry.note ??= row.note;
  }
  return [...byId.values()];
}

const listingColumns = {
  target: targetTable,
  section: awesomeItemTable.section,
  sectionSlug: awesomeItemTable.sectionSlug,
  title: awesomeItemTable.title,
  note: awesomeItemTable.note,
  position: awesomeItemTable.position,
};

/** everything a config entry features, in the order that entry chose */
export async function targetsForList(
  entry: ConfigEntry,
): Promise<TargetWithSections[]> {
  const rows = await db
    .select(listingColumns)
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .where(D.inArray(awesomeItemTable.listId, entry.sourceIds))
    .orderBy(...listingOrder(entry));

  return groupSections(rows);
}

export type Category = {
  /** the URL segment path, i.e. what `categoryPath()` takes */
  slug: string;
  /**
   * What `awesome_item.section_slug` actually holds: the empty string for the
   * headingless bucket, identical to `slug` otherwise. Kept separate so
   * `targetsForCategory` can be handed the storage key without having to guess
   * whether "uncategorized" means the bucket or a heading someone really wrote.
   */
  sectionSlug: string;
  path: string[];
  /** distinct targets under the heading, which is what the page paginates */
  count: number;
  /**
   * How many of those are repositories, i.e. how many carry stars and a pulse.
   *
   * `count - repoCount` is the rest: sites, registries, whatever the curator
   * linked that we can only show a name and a note for. The gap matters to the
   * sitemap, which does not advertise a heading made entirely of those; see
   * `sitemap.ts`.
   */
  repoCount: number;
};

/**
 * The heading paths of a config entry, with how much each one holds.
 *
 * Joins `target` rather than counting awesome_item alone: a list keeps linking
 * repositories that were since deleted or made private, and those never get a
 * `target` row. Counting them would inflate every category and, for a section
 * whose repos are all gone, emit a category page with nothing on it.
 *
 * Rows with no heading are not dropped any more; they become the synthetic
 * `UNCATEGORIZED_SLUG` category, which is what makes them crawlable.
 */
export async function categoriesForList(
  entry: ConfigEntry,
): Promise<Category[]> {
  const count = D.sql<number>`count(distinct ${awesomeItemTable.targetId})`;
  const repoCount = D.sql<number>`count(distinct case when ${targetTable.kind} = 'github' then ${awesomeItemTable.targetId} end)`;
  /*
   * Several heading paths can slugify to one category, and then one of them has
   * to be the name of the page. `min()` picks it, rather than the bare column,
   * whose value sqlite is free to take from whichever row it likes: "Misc" and
   * "Misc." are the same category written twice and merging them is right, but a
   * page whose title changes between builds is not.
   *
   * `variants` is how the case stops being invisible. Merging headings that
   * differ by a full stop is fine; merging two that do not is a slug that needs
   * fixing (see `slugify`, which had exactly that bug for C, C++ and C#), and a
   * warning in the build log is where that gets noticed.
   */
  const section = D.sql<string>`min(${awesomeItemTable.section})`;
  const variants = D.sql<string>`group_concat(distinct ${awesomeItemTable.section})`;
  const rows = await db
    .select({
      slug: awesomeItemTable.sectionSlug,
      section,
      variants,
      count,
      repoCount,
    })
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .where(D.inArray(awesomeItemTable.listId, entry.sourceIds))
    .groupBy(awesomeItemTable.sectionSlug)
    .orderBy(D.desc(count));

  // Two ways a README could take a URL this site has already spoken for, both
  // of which the nightly crawl could introduce without anyone editing code, and
  // both of which fail silently: a duplicate getStaticPaths entry, or a
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
    const path = JSON.parse(row.section) as string[];
    const section = sectionOf(row.slug, path);
    if (row.variants && row.variants.includes("],[")) {
      console.warn(
        `[categories] ${entry.slug}/${section.slug}: several headings share ` +
          `this slug (${row.variants}); the page is titled after the first`,
      );
    }
    return {
      slug: section.slug,
      sectionSlug: row.slug,
      path: section.path,
      count: row.count,
      repoCount: row.repoCount,
    };
  });
}

/**
 * Everything filed under one heading path of one config entry.
 *
 * `sectionSlug` is the *stored* slug, i.e. `Category.sectionSlug` and not
 * `Category.slug`: pass `""` to get the headingless bucket the site publishes
 * at `UNCATEGORIZED_SLUG`.
 */
export async function targetsForCategory(
  entry: ConfigEntry,
  sectionSlug: string,
): Promise<TargetWithSections[]> {
  const rows = await db
    .select(listingColumns)
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .where(
      D.and(
        D.inArray(awesomeItemTable.listId, entry.sourceIds),
        D.eq(awesomeItemTable.sectionSlug, sectionSlug),
      ),
    )
    .orderBy(...listingOrder(entry));

  return groupSections(rows);
}

export type TopRepo = Target & {
  /** the names of the config entries that curate it, in config order */
  lists: string[];
};

/**
 * The most starred projects in the dataset, whichever list they came from.
 *
 * This is what the search page shows before anybody has searched. It used to
 * ask Pagefind for "everything, sorted by stars", which is the one query
 * Pagefind is bad at — with no term it has to materialise and rank all 30,464
 * records, and that took seven seconds before a single result appeared. The
 * answer never changes between builds, so it is a query here instead and the
 * index is not touched until the reader actually types or filters.
 *
 * Repositories by construction: a row has to have stars to be sorted by them.
 */
export async function topStarred(limit: number): Promise<TopRepo[]> {
  const entries = await loadConfig();
  const nameOfSource = new Map(
    entries.flatMap((entry) =>
      entry.sourceIds.map((id) => [id, entry.name] as const),
    ),
  );

  // asks for more than it needs: a target whose only list has since left
  // config.yaml is not on this site and is dropped below, exactly as the
  // search index drops it
  const rows = await db
    .select({ target: targetTable })
    .from(targetTable)
    .innerJoin(
      awesomeItemTable,
      D.eq(awesomeItemTable.targetId, targetTable.id),
    )
    .where(D.isNotNull(targetTable.stars))
    .groupBy(targetTable.id)
    .orderBy(D.desc(targetTable.stars))
    .limit(limit * 2);

  const ids = rows.map((row) => row.target.id);
  const items = await db
    .select({
      targetId: awesomeItemTable.targetId,
      listId: awesomeItemTable.listId,
    })
    .from(awesomeItemTable)
    .where(D.inArray(awesomeItemTable.targetId, ids));

  const listsOf = new Map<string, Set<string>>();
  for (const item of items) {
    const name = nameOfSource.get(item.listId);
    if (!name) continue;
    const names = listsOf.get(item.targetId) ?? new Set<string>();
    names.add(name);
    listsOf.set(item.targetId, names);
  }

  const top: TopRepo[] = [];
  for (const row of rows) {
    const names = listsOf.get(row.target.id);
    if (!names) continue;
    top.push({ ...row.target, lists: [...names] });
    if (top.length === limit) break;
  }
  return top;
}

export type ListSummary = {
  entry: ConfigEntry;
  /** distinct targets, i.e. every row the list page paginates */
  entryCount: number;
  /** how many of those are not repositories, and so carry no pulse */
  linkCount: number;
  /** most recent push across the list, i.e. how fresh the niche itself is */
  lastActivity: Date | undefined;
};

let summariesCache: ListSummary[] | undefined;

/**
 * Config entries that actually have crawled data, with their size.
 *
 * A list declared in config.yaml but never crawled has no rows, and every route
 * builds off this: emitting a page for an empty list would ship thin content
 * and put a dead link in the sitemap.
 *
 * Memoised because the site header renders it on every page: one query per
 * config entry is nothing once, and 80 of them across 34,000 pages is a build
 * that never finishes. The database is a file we regenerate wholesale between
 * builds, so there is no window in which the cache could go stale mid-run.
 * `astro dev` picks up a fresh crawl on restart, exactly like `loadConfig`.
 */
export async function listSummaries(): Promise<ListSummary[]> {
  if (summariesCache) return summariesCache;
  const entries = await loadConfig();
  const summaries: ListSummary[] = [];

  for (const entry of entries) {
    const [row] = await db
      .select({
        entryCount: D.sql<number>`count(distinct ${awesomeItemTable.targetId})`,
        linkCount: D.sql<number>`count(distinct case when ${targetTable.kind} != 'github' then ${awesomeItemTable.targetId} end)`,
        lastActivity: D.sql<number | null>`max(${targetTable.lastActivityAt})`,
      })
      .from(awesomeItemTable)
      .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
      .where(D.inArray(awesomeItemTable.listId, entry.sourceIds));

    if (!row || row.entryCount === 0) continue;
    summaries.push({
      entry,
      entryCount: row.entryCount,
      linkCount: row.linkCount,
      lastActivity: row.lastActivity
        ? new Date(row.lastActivity * 1000)
        : undefined,
    });
  }

  summariesCache = summaries.sort((a, b) => b.entryCount - a.entryCount);
  return summariesCache;
}

export type DatasetTotals = {
  /** distinct targets across every crawled list, i.e. what search covers */
  targets: number;
  /** the repositories among them, which are the ones with a pulse */
  repos: number;
  /** the rest: a project's own site, and whatever else a curator linked */
  links: number;
};

let totalsCache: DatasetTotals | undefined;

/**
 * How big the dataset is, counted once.
 *
 * Distinct targets, not list entries: a project linked by both awesome-go and
 * awesome-selfhosted is one row here and two on the list pages, on purpose,
 * because each list counts its own. The home page, the search page and the
 * footer all state this number, so it is derived in one place — three readings
 * of "projects" a screen apart that disagree read as a bug, not as a definition.
 */
export async function datasetTotals(): Promise<DatasetTotals> {
  if (totalsCache) return totalsCache;
  const [row] = await db
    .select({
      targets: D.sql<number>`count(distinct ${awesomeItemTable.targetId})`,
      repos: D.sql<number>`count(distinct case when ${targetTable.kind} = 'github' then ${awesomeItemTable.targetId} end)`,
    })
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId));

  const targets = row?.targets ?? 0;
  const repos = row?.repos ?? 0;
  totalsCache = { targets, repos, links: targets - repos };
  return totalsCache;
}

let overallPulseCache: PulseBreakdown | undefined;

/**
 * The pulse split of the dataset as a whole, which is the one number the home
 * page leads with.
 *
 * Not the sum of `listPulses()`: a repository linked by both awesome-go and
 * awesome-selfhosted is two rows there, on purpose, because each list page
 * counts its own entries. Here it is one project, so the query deduplicates
 * across lists first. The gap is real, 32,596 list entries against 30,464
 * distinct repositories, and averaging the per-list shares instead would let
 * the 80 lists vote by count rather than by size.
 *
 * The denominator is the targets that *have* a last activity date. A website has
 * none, and folding those in as a fifth bucket, or as dormant ones, would make
 * the one figure this site exists to publish depend on how many of a list's
 * entries happen to live on GitHub.
 */
export async function overallPulse(): Promise<PulseBreakdown> {
  if (overallPulseCache) return overallPulseCache;
  const rows = await db
    .selectDistinct({
      targetId: awesomeItemTable.targetId,
      lastActivityAt: targetTable.lastActivityAt,
    })
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .where(D.isNotNull(targetTable.lastActivityAt));

  overallPulseCache = pulseBreakdown(rows);
  return overallPulseCache;
}

/** null once resolved and found empty, so an empty database is not re-queried */
let crawledAtCache: Date | null | undefined;

/**
 * When the dataset was last refreshed: the most recent `refreshedAt` across
 * every target, which is the moment the crawl actually ran.
 *
 * `awesome_list.updatedAt` is the more obvious source and the wrong one: it
 * only moves when a README changed, so a footer built on it would tell a reader
 * the figures were months old on a site crawled last night.
 *
 * Memoised for the same reason as `listSummaries`: the footer is on every one
 * of the ~34,000 pages.
 */
export async function lastCrawledAt(): Promise<Date | undefined> {
  if (crawledAtCache === undefined) {
    const [row] = await db
      .select({ at: D.sql<number | null>`max(${targetTable.refreshedAt})` })
      .from(targetTable);
    crawledAtCache = row?.at ? new Date(row.at * 1000) : null;
  }
  return crawledAtCache ?? undefined;
}

/**
 * The pulse split of every config entry, keyed by slug.
 *
 * One pass over the whole join rather than a query per list: the home page
 * needs all 80 of them at once, and the bucketing happens in JavaScript so the
 * thresholds stay defined exactly once, in `liveness()`. A merged entry is
 * deduplicated across its source lists first, since a repository both
 * awesome-mac and open-source-mac-os-apps link is one project on the MacOS
 * page, and it would otherwise be counted twice here.
 */
export async function listPulses(): Promise<Map<string, PulseBreakdown>> {
  const entries = await loadConfig();

  const rows = await db
    .selectDistinct({
      listId: awesomeItemTable.listId,
      targetId: awesomeItemTable.targetId,
      lastActivityAt: targetTable.lastActivityAt,
    })
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .where(D.isNotNull(targetTable.lastActivityAt));

  const bySource = new Map<
    string,
    { targetId: string; lastActivityAt: Date }[]
  >();
  for (const row of rows) {
    if (!row.lastActivityAt) continue;
    const list = bySource.get(row.listId) ?? [];
    list.push({ targetId: row.targetId, lastActivityAt: row.lastActivityAt });
    bySource.set(row.listId, list);
  }

  const pulses = new Map<string, PulseBreakdown>();
  for (const entry of entries) {
    const seen = new Map<string, Date>();
    for (const sourceId of entry.sourceIds) {
      for (const row of bySource.get(sourceId) ?? []) {
        seen.set(row.targetId, row.lastActivityAt);
      }
    }
    pulses.set(
      entry.slug,
      pulseBreakdown(
        [...seen.values()].map((lastActivityAt) => ({ lastActivityAt })),
      ),
    );
  }

  return pulses;
}
