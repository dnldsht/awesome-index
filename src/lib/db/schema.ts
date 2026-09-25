import { relations, type InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { PopularitySource } from "../popularity.ts";
import type { TargetKind } from "../targets.ts";

/**
 * One row per awesome list we crawl, keyed by "<owner>/<repo>". `readmeDigest`
 * pairs the blob sha GitHub returns for the README with the version of the
 * parser that read it, so an unchanged list is left alone but a smarter parser
 * still reaches it.
 */
export const awesomeListTable = sqliteTable("awesome_list", {
  id: text("id").primaryKey().notNull(),
  readmeDigest: text("readme_digest").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

/**
 * One row per link found in a list README, carrying the heading path it sits
 * under. This is what the old dataset threw away: a flat `string[]` of repo ids
 * per list, with no way to tell that `hyperium/hyper` lives under
 * "Network programming › HTTP", which is exactly what a category page needs.
 *
 * The same target can legitimately appear under several sections of the same
 * list, hence the composite key.
 */
export const awesomeItemTable = sqliteTable(
  "awesome_item",
  {
    listId: text("list_id")
      .notNull()
      .references(() => awesomeListTable.id, { onDelete: "cascade" }),
    /**
     * What the entry points at: `target.id`. Not a foreign key, deliberately:
     * a list keeps linking repositories GitHub has since deleted, and those
     * never get a `target` row. The join is what drops them: the shard
     * builder inner-joins `target`, so an entry we know nothing about never
     * reaches a payload.
     */
    targetId: text("target_id").notNull(),
    /** heading path, outermost first: ["Applications", "Audio"] */
    section: text("section", { mode: "json" }).$type<string[]>().notNull(),
    /** url-safe join of `section`: "applications/audio" */
    sectionSlug: text("section_slug").notNull(),
    /**
     * The text of the link, i.e. what the curator calls the thing.
     *
     * A GitHub row takes its name from its id and does not need this. Nothing
     * else has an id worth showing ("https://gtkmm.org/en" is an address, not
     * a name), so the one thing the parser used to throw away is now the only
     * name those rows have. Stored per appearance, like the note: two lists may
     * write the same project under different names and neither is wrong.
     */
    title: text("title"),
    /** the prose the list author wrote next to the link */
    note: text("note"),
    /** order of appearance in the README, so we can preserve the curation */
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.targetId, t.sectionSlug] }),
    index("awesome_item_target_idx").on(t.targetId),
    index("awesome_item_section_idx").on(t.listId, t.sectionSlug),
  ],
);

/**
 * Everything we know about a thing a list links, whoever hosts it.
 *
 * This was `github_repo`, when every row on the site was a repository. It is
 * one table with a `kind` rather than one table per provider because the site
 * renders them side by side, sorts them in one order and counts them in one
 * total: a query that had to know where a row came from would have to know it in
 * `reposForList`, in `categoriesForList`, in the sitemap and in the search
 * index. Instead the provider-specific columns are simply null where they do not
 * apply, which is also the difference this dataset has to be able to state: a
 * repository with `stars = 0` has none, a website has no such notion.
 *
 * See `src/lib/targets.ts` for what `kind` and `id` are, and why a GitHub id is
 * `<owner>/<name>` while everyone else's is a URL.
 */
export const targetTable = sqliteTable(
  "target",
  {
    id: text("id").primaryKey().notNull(),
    kind: text("kind").$type<TargetKind>().notNull(),
    /** the link a row points at; for github, derived from the id */
    url: text("url").notNull(),
    description: text("description").notNull().default(""),

    /* -- provider metadata, null where the provider has no such notion ----- */

    stars: integer("stars"),
    forks: integer("forks"),
    license: text("license"),
    primaryLanguage: text("primary_language"),
    archived: integer("archived", { mode: "boolean" }),
    /**
     * The last time the thing itself moved: `pushedAt` for a repository, and
     * where a registry provider gets added, its newest release. Null for a
     * `web` target, which is the whole reason it is nullable: an entry with no
     * pulse is not a dormant one, and every pulse denominator on the site
     * counts the rows that have this and no others.
     */
    lastActivityAt: integer("last_activity_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }),

    /* -- github only ------------------------------------------------------- */

    /**
     * GitHub's numeric repo id, i.e. what `databaseId` is called in GraphQL.
     *
     * Star history is fetched by id (`/repositories/{id}/stargazers/history`)
     * rather than by `<owner>/<name>`, because a rename otherwise silently
     * splits a repository's history in two: the old name keeps answering
     * through GitHub's redirect, the new one starts its own row, and neither
     * series is wrong enough to notice. The id survives renames, transfers and
     * the owner changing their login.
     *
     * Null until the harvesting pass has seen the row, and null forever on a
     * `web` target, which has no such notion.
     */
    databaseId: integer("database_id"),

    /** the "Website" GitHub shows next to a repo, absent on most of them */
    homepageUrl: text("homepage_url"),
    topics: text("topics", { mode: "json" }).$type<string[]>(),
    ownerLogin: text("owner_login"),
    ownerAvatarUrl: text("owner_avatar_url"),

    /* -- reachability, for the targets whose liveness is not a commit ------- */

    /**
     * "ok" when it last answered, "dead" when it has stopped answering, null
     * when we have never had a clear answer either way.
     *
     * Only `web` targets carry it: a repository that stops existing loses its
     * row entirely, which is the older and blunter version of the same idea.
     */
    status: text("status").$type<"ok" | "dead">(),
    checkedAt: integer("checked_at", { mode: "timestamp" }),
    lastOkAt: integer("last_ok_at", { mode: "timestamp" }),
    /**
     * Consecutive checks that failed *hard* (no such host, refused, 404, 410).
     * A bot wall answering 403, a timeout and a 502 leave it alone: they mean
     * "we could not tell", and calling that dead once would mark thousands of
     * live projects dead on one bad night in CI. See `src/lib/liveness.ts`.
     */
    failStreak: integer("fail_streak").notNull().default(0),

    /* -- popularity, for the targets whose popularity is not a star count --- */

    /**
     * A rank comparable across the whole dataset, in stars.
     *
     * `stars` answers "how many people starred this repository" and is left
     * alone: it stays null on everything that cannot be starred, which is the
     * distinction the rest of this file and every row on the site are built
     * on. This answers the different question the listings actually ask,
     * "where does this belong in the order", for the rows that have no star
     * count but do have some other evidence of being wanted.
     *
     * Expressed as a *star equivalent* so one `order by` can rank a repository
     * against a crate against a Codeberg project: the row's percentile inside
     * its own population is looked up in the star distribution of the GitHub
     * repositories *in this dataset*. That last part is the whole reason the
     * mapping is defensible. Both populations are already "things an awesome
     * list chose to link", so the percentiles are measured against comparable
     * cohorts rather than against every repository on GitHub.
     *
     * Never rendered as a star count. 200 stars on Codeberg is the 96th
     * percentile of Codeberg and the 37th of GitHub, so the number that sorts
     * it correctly is not the number to show a reader; `popularityRaw` is.
     */
    popularity: integer("popularity"),
    /**
     * Where `popularity` came from, which decides how a row may state it.
     *
     * `inherited` and `registryRepo` resolved to a real GitHub repository, so
     * their `popularityRaw` *is* a star count and can be shown as one, credited
     * to the repository it belongs to. `forge` and `registryNative` did not:
     * their raw figure is somebody else's unit (Codeberg stars, monthly
     * downloads, MetaCPAN "++") and has to be named.
     */
    popularitySource: text("popularity_source").$type<PopularitySource>(),
    /**
     * What the figure belongs to: "facebook/react", "crates.io/serde",
     * "codeberg.org/forgejo/forgejo". Shown next to the number, because a
     * count borrowed from somewhere else and presented bare is the one thing
     * this dataset should not do.
     */
    popularityRef: text("popularity_ref"),
    /**
     * The figure as measured, in its own unit, before calibration.
     *
     * Kept because it is the only honest thing to display, and because
     * `popularity` is derived from a distribution that moves: a recalibration
     * has to be able to recompute the sort key without asking every registry
     * again.
     */
    popularityRaw: integer("popularity_raw"),
    /**
     * The population `popularityRaw` was ranked inside, which is also the name
     * of its unit: "codeberg.org", "crates.io:recentDownloads".
     *
     * Two jobs, and the second is the one that makes it a column rather than a
     * detail of the resolver. A reader has to be told what a number counts, and
     * "1.6M" next to a package means nothing until it says downloads. And a
     * recalibration (the star distribution moves every crawl) has to be able
     * to regroup the stored figures into their cohorts and remap them, which it
     * cannot do from the figure alone.
     */
    popularityCohort: text("popularity_cohort"),

    /** when *we* last refreshed this row, drives --stale-days */
    refreshedAt: integer("refreshed_at", { mode: "timestamp" })
      .notNull()
      .$default(() => new Date()),
  },
  (t) => [
    index("target_stars_idx").on(t.stars),
    index("target_activity_idx").on(t.lastActivityAt),
    index("target_kind_idx").on(t.kind),
    index("target_popularity_idx").on(t.popularity),
  ],
);

/**
 * Weekly star deltas, one row per repository per week.
 *
 * The source is `GET /repositories/{databaseId}/stargazers/history`, which
 * GitHub shipped in September 2026 to replace the page-sampling of
 * `/stargazers` that it had restricted three months earlier. It returns
 * `{ week, total, days }` newest first, 30 weeks to a page, and it is exact
 * rather than sampled.
 *
 * What is kept is the *delta*, not the running total GitHub sends. The totals
 * are a cumulative series and a cumulative series is the wrong thing to store
 * for a question about change: every window the site offers (7 days, 30 days,
 * a year) is a sum of deltas, the trend score is a comparison of deltas
 * against each other, and the current total is already `target.stars`. Storing
 * both would be storing the same information twice and inviting them to
 * disagree after a crawl that only refreshed one of them.
 *
 * `delta` may be negative. People unstar things, and a week that lost stars is
 * a fact about the repository, not a fetch error to be clamped away.
 *
 * The rows are build-time input and never reach a payload: the shard carries
 * three integers derived from them (see `src/lib/contracts.ts`), and the full
 * curve, when a reader asks for it, comes from star-history.com.
 *
 * Keyed by `target.id` rather than by `databaseId` so it joins the rest of the
 * dataset directly; the numeric id is how the row is *fetched*, not how it is
 * addressed here. Not a foreign key, for the same reason `awesome_item` is not:
 * history collected for a repository that GitHub later deletes should not take
 * a cascade with it.
 */
export const starHistoryTable = sqliteTable(
  "star_history",
  {
    targetId: text("target_id").notNull(),
    /** unix timestamp of the week start, exactly as GitHub returns it */
    week: integer("week").notNull(),
    /** net stars gained that week; may be negative */
    delta: integer("delta").notNull(),
  },
  (t) => [primaryKey({ columns: [t.targetId, t.week] })],
);

/**
 * Where the history fetcher got to, one row per repository.
 *
 * Two jobs, and both of them are about not asking GitHub the same question
 * twice. A full backfill is thirteen hours of paced requests against a
 * 5,000/hour quota, so it has to survive being killed at hour nine and resume
 * rather than start again: that is `pagesDone`. And the weekly refresh has to
 * be cheap on the overwhelming majority of repositories that gained no stars
 * since it last looked: that is `etagPage1`, because a 304 does not consume
 * quota at all.
 *
 * Pages beyond the first can never change: the endpoint counts backwards from
 * the present, so page 2 is a closed interval of weeks that has already
 * happened. Once stored they are free forever, and deepening the history later
 * costs only the pages beyond `pagesDone`.
 */
export const historyFetchTable = sqliteTable("history_fetch", {
  targetId: text("target_id").primaryKey().notNull(),
  /** deepest page successfully stored; the backfill resumes from page + 1 */
  pagesDone: integer("pages_done").notNull().default(0),
  /**
   * The ETag of page 1 as of the last fetch, replayed as `If-None-Match` on the
   * next one. Only page 1 needs it; the rest are immutable.
   */
  etagPage1: text("etag_page1"),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }),
  /**
   * The repository has stopped answering for a reason that will not change on
   * its own: 404 (deleted or made private), 451 (taken down). Set so the
   * fetcher stops spending a request per run rediscovering it; a row that is
   * merely rate-limited or briefly 500ing is left alone, exactly as
   * `failStreak` above distinguishes "gone" from "could not tell".
   */
  gone: integer("gone", { mode: "boolean" }).notNull().default(false),
});

export const awesomeListRelations = relations(awesomeListTable, ({ many }) => ({
  items: many(awesomeItemTable),
}));

export const awesomeItemRelations = relations(awesomeItemTable, ({ one }) => ({
  list: one(awesomeListTable, {
    fields: [awesomeItemTable.listId],
    references: [awesomeListTable.id],
  }),
  target: one(targetTable, {
    fields: [awesomeItemTable.targetId],
    references: [targetTable.id],
  }),
}));

export type AwesomeList = InferSelectModel<typeof awesomeListTable>;
export type AwesomeItem = InferSelectModel<typeof awesomeItemTable>;
export type Target = InferSelectModel<typeof targetTable>;
