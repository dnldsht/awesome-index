import { relations, type InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
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
     * What the entry points at: `target.id`. Not a foreign key, deliberately —
     * a list keeps linking repositories GitHub has since deleted, and those
     * never get a `target` row. The join is what drops them (see queries.ts).
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
     * else has an id worth showing — "https://gtkmm.org/en" is an address, not
     * a name — so the one thing the parser used to throw away is now the only
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
     * `web` target, which is the whole reason it is nullable — an entry with no
     * pulse is not a dormant one, and every pulse denominator on the site
     * counts the rows that have this and no others.
     */
    lastActivityAt: integer("last_activity_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }),

    /* -- github only ------------------------------------------------------- */

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

    /** when *we* last refreshed this row, drives --stale-days */
    refreshedAt: integer("refreshed_at", { mode: "timestamp" })
      .notNull()
      .$default(() => new Date()),
  },
  (t) => [
    index("target_stars_idx").on(t.stars),
    index("target_activity_idx").on(t.lastActivityAt),
    index("target_kind_idx").on(t.kind),
  ],
);

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
