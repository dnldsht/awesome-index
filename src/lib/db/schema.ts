import { relations, type InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * One row per awesome list we crawl, keyed by "<owner>/<repo>". `readmeDigest`
 * is the blob sha GitHub returns for the README, so an unchanged list is
 * detected without re-parsing it.
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
 * The same repo can legitimately appear under several sections of the same
 * list, hence the composite key.
 */
export const awesomeItemTable = sqliteTable(
  "awesome_item",
  {
    listId: text("list_id")
      .notNull()
      .references(() => awesomeListTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    /** heading path, outermost first: ["Applications", "Audio"] */
    section: text("section", { mode: "json" }).$type<string[]>().notNull(),
    /** url-safe join of `section`: "applications/audio" */
    sectionSlug: text("section_slug").notNull(),
    /** the prose the list author wrote next to the link */
    note: text("note"),
    /** order of appearance in the README, so we can preserve the curation */
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.repoId, t.sectionSlug] }),
    index("awesome_item_repo_idx").on(t.repoId),
    index("awesome_item_section_idx").on(t.listId, t.sectionSlug),
  ],
);

/**
 * Metadata for every repository linked from any list. Refreshed in batches
 * through the GraphQL API, see bin/crawl.ts.
 */
export const githubRepoTable = sqliteTable(
  "github_repo",
  {
    id: text("id").primaryKey().notNull(),
    description: text("description").notNull().default(""),
    topics: text("topics", { mode: "json" }).$type<string[]>().notNull(),
    ownerLogin: text("owner_login").notNull(),
    ownerAvatarUrl: text("owner_avatar_url").notNull(),

    stars: integer("stars").notNull(),
    forks: integer("forks").notNull(),
    license: text("license"),
    primaryLanguage: text("primary_language").notNull().default(""),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),

    pushedAt: integer("pushed_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    /** when *we* last refreshed this row, drives --stale-days */
    refreshedAt: integer("refreshed_at", { mode: "timestamp" })
      .notNull()
      .$default(() => new Date()),
  },
  (t) => [
    index("github_repo_stars_idx").on(t.stars),
    index("github_repo_pushed_idx").on(t.pushedAt),
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
  repo: one(githubRepoTable, {
    fields: [awesomeItemTable.repoId],
    references: [githubRepoTable.id],
  }),
}));

export type AwesomeList = InferSelectModel<typeof awesomeListTable>;
export type AwesomeItem = InferSelectModel<typeof awesomeItemTable>;
export type GithubRepo = InferSelectModel<typeof githubRepoTable>;
