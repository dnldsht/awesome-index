/**
 * Builds the Pagefind index straight from the dataset.
 *
 * This used to be one line in `package.json` — `pagefind --site dist` — and the
 * index was a by-product of 30,464 repository pages, each carrying
 * `data-pagefind-body`. Those pages are gone: everything they showed beyond the
 * curator's note was a copy of what github.com already says better, and they
 * were 88% of the site's URLs and 64% of its bytes.
 *
 * The search did not have to go with them. Pagefind's node API indexes records
 * that were never HTML, so one record per project is written here from the same
 * sqlite rows the listing pages render, and its `url` points at github.com —
 * which is where a reader clicking a result was headed anyway.
 *
 * Three things this does better than parsing pages did:
 *
 * - `filters` is a real `string[]` per key, so `list` is multi-valued by
 *   construction. The pages had to emit one tagged element per appearance and
 *   trust Pagefind to collect them into one filter.
 * - no value has to survive an HTML attribute, so the `key:value` escaping in
 *   `search.ts` is gone with the pages that needed it.
 * - a record holds the project's own words and nothing else, rather than
 *   whatever survived `data-pagefind-body` and `data-pagefind-ignore` on a page
 *   that also had a header, a stat grid and six neighbouring cards on it.
 *
 * The shape of the index is deliberately untouched: the same filter keys, the
 * same sort keys and the same meta the island already reads, all still named
 * once in `src/lib/search.ts` and imported from there.
 *
 * Neither is the file count, which is worth knowing before choosing a host.
 * Pagefind writes one fragment per record either way, so the bundle is ~30,700
 * files — 17MB of actual bytes, but nearer 125MB on disk once a 4KB block per
 * file is counted. This directory, not the pages, is what a file-count cap
 * would run into.
 *
 * Usage: pnpm build (i.e. `astro build && node bin/index-search.ts`)
 */
import * as D from "drizzle-orm";
import { parseArgs } from "node:util";
import * as pagefind from "pagefind";
import { loadConfig } from "../src/lib/config.ts";
import { db } from "../src/lib/db/client.ts";
import { awesomeItemTable, githubRepoTable } from "../src/lib/db/schema.ts";
import { liveness } from "../src/lib/format.ts";
import { sectionOf } from "../src/lib/queries.ts";
import {
  nameSortValue,
  pushedSortValue,
  starsSortValue,
} from "../src/lib/search.ts";
import { githubUrl } from "../src/lib/urls.ts";

const { values: flags } = parseArgs({
  options: {
    out: { type: "string", default: "dist/pagefind" },
    // the service answers one request per record; batching keeps 30k round
    // trips from being 30k sequential waits without flooding a stdio pipe
    concurrency: { type: "string", default: "64" },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`node bin/index-search.ts [options]

  --out=PATH         where to write the bundle (default dist/pagefind)
  --concurrency=N    records added in parallel (default 64)
`);
  process.exit(0);
}

/** one config entry that features a repository, as the index describes it */
type Appearance = {
  slug: string;
  name: string;
  /** the heading paths of this list it was filed under, "Packages › HTTP" */
  sections: string[];
  /** every distinct note this list's curators wrote about it */
  notes: string[];
};

const [entries, repoRows, itemRows] = await Promise.all([
  loadConfig(),
  db.select().from(githubRepoTable),
  db
    .select({
      listId: awesomeItemTable.listId,
      repoId: awesomeItemTable.repoId,
      section: awesomeItemTable.section,
      sectionSlug: awesomeItemTable.sectionSlug,
      note: awesomeItemTable.note,
    })
    .from(awesomeItemTable)
    .orderBy(D.asc(awesomeItemTable.listId), D.asc(awesomeItemTable.position)),
]);

const repoById = new Map(repoRows.map((row) => [row.id, row]));

// awesome_item is keyed by source list id ("rust-unofficial/awesome-rust") while
// the site is keyed by config slug, and one entry can merge several source lists
// (JavaScript is sorrycc + uhub), so several ids collapse onto one appearance
const entryOfList = new Map(
  entries.flatMap((entry) => entry.sourceIds.map((id) => [id, entry] as const)),
);
const entryOrder = new Map(entries.map((entry, i) => [entry.slug, i]));

const appearancesOf = new Map<string, Map<string, Appearance>>();

for (const item of itemRows) {
  // a repository the list links but GitHub no longer serves has no metadata row,
  // and a list crawled once that has since left config.yaml has no entry
  if (!repoById.has(item.repoId)) continue;
  const entry = entryOfList.get(item.listId);
  if (!entry) continue;

  let byEntry = appearancesOf.get(item.repoId);
  if (!byEntry) {
    byEntry = new Map();
    appearancesOf.set(item.repoId, byEntry);
  }

  let appearance = byEntry.get(entry.slug);
  if (!appearance) {
    appearance = {
      slug: entry.slug,
      name: entry.name,
      sections: [],
      notes: [],
    };
    byEntry.set(entry.slug, appearance);
  }

  // entries sitting above every heading are filed under the synthetic bucket,
  // exactly as the category pages file them
  const label = sectionOf(item.sectionSlug, item.section).path.join(" › ");
  if (!appearance.sections.includes(label)) appearance.sections.push(label);

  const note = item.note?.trim();
  if (note && !appearance.notes.includes(note)) appearance.notes.push(note);
}

/**
 * What a query is actually matched against.
 *
 * The id leads, because "tokio" is how somebody looks for tokio. Then the
 * project's own description, then the curators' prose — the one part of this
 * that exists nowhere else, and the reason the dataset is worth searching. Then
 * the headings it was filed under and the lists that curate it, so "http
 * client" reaches a library whose description says neither word but whose
 * curator filed it under "HTTP".
 *
 * Topics come last, unpunctuated: they are keywords, not a sentence.
 */
function contentOf(
  repo: (typeof repoRows)[number],
  appearances: Appearance[],
): string {
  const description = repo.description.trim();
  const parts = [repo.id, repo.ownerLogin, description];

  for (const appearance of appearances) {
    parts.push(appearance.name, ...appearance.sections);
    // a note that only repeats the description is not worth a second copy in
    // the index; list authors often paste the blurb they found on GitHub
    for (const note of appearance.notes) {
      if (note !== description) parts.push(note);
    }
  }

  if (repo.primaryLanguage) parts.push(repo.primaryLanguage);
  if (repo.topics.length > 0) parts.push(repo.topics.join(" "));

  return parts.filter(Boolean).join(". ");
}

const { index, errors: openErrors } = await pagefind.createIndex();
if (!index) {
  console.error(`pagefind: could not start\n${openErrors.join("\n")}`);
  process.exit(1);
}

const failures: string[] = [];
const concurrency = Math.max(1, Number(flags.concurrency) || 1);
const ids = [...appearancesOf.keys()];

for (let i = 0; i < ids.length; i += concurrency) {
  await Promise.all(
    ids.slice(i, i + concurrency).map(async (id) => {
      const repo = repoById.get(id);
      const byEntry = appearancesOf.get(id);
      if (!repo || !byEntry) return;

      const appearances = [...byEntry.values()].sort(
        (a, b) => (entryOrder.get(a.slug) ?? 0) - (entryOrder.get(b.slug) ?? 0),
      );
      const pulse = liveness(repo.pushedAt);
      const archived = repo.archived ? "yes" : "no";
      const description = repo.description.trim();

      // Only keys with a value: a repository with no detected language must not
      // become a `language: ""` row in the facet, which is how a filter ends up
      // offering a blank checkbox that matches 8,000 projects.
      const filters: Record<string, string[]> = {
        list: appearances.map((appearance) => appearance.slug),
        pulse: [pulse],
        archived: [archived],
      };
      if (repo.primaryLanguage) filters["language"] = [repo.primaryLanguage];
      if (repo.license) filters["license"] = [repo.license];

      const meta: Record<string, string> = {
        title: repo.id,
        stars: String(repo.stars),
        pushed: pushedSortValue(repo.pushedAt),
        pulse,
        archived,
        // the byline on a result card: which lists thought this was worth
        // linking, which is the one thing a github.com search cannot tell you
        lists: appearances.map((appearance) => appearance.name).join(" · "),
      };
      if (description) meta["blurb"] = description;
      if (repo.primaryLanguage) meta["language"] = repo.primaryLanguage;
      if (repo.license) meta["license"] = repo.license;

      const { errors } = await index.addCustomRecord({
        // Pagefind stores this verbatim and hands it back to the island, so a
        // result links to github.com without the site having a page of its own
        url: githubUrl(repo.id),
        content: contentOf(repo, appearances),
        language: "en",
        meta,
        filters,
        // zero-padded / date-shaped, because Pagefind compares sort values as
        // strings; see the helpers in search.ts
        sort: {
          stars: starsSortValue(repo.stars),
          pushed: pushedSortValue(repo.pushedAt),
          name: nameSortValue(repo.id),
        },
      });

      if (errors.length > 0) failures.push(`${repo.id}: ${errors.join(", ")}`);
    }),
  );
}

if (failures.length > 0) {
  console.error(
    `pagefind: ${failures.length} records rejected\n` +
      failures.slice(0, 10).join("\n"),
  );
  process.exit(1);
}

const written = await index.writeFiles({ outputPath: flags.out! });
await pagefind.close();

if (written.errors.length > 0) {
  console.error(`pagefind: ${written.errors.join("\n")}`);
  process.exit(1);
}

console.log(
  `indexed ${ids.length.toLocaleString("en")} projects into ${written.outputPath}`,
);
