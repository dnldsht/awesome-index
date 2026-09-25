/**
 * Writes the fixtures the front end is built against, from the current
 * dataset.
 *
 * The page work does not need a crawl, a token or any star history to start.
 * It needs one realistic shard and one front page, in exactly the shape
 * `src/lib/contracts.ts` describes. This emits them, so that the four strands
 * of the rewrite can run at once instead of queueing behind the pipeline.
 *
 * The history-derived fields (`d7`, `d30`, `d365`, `state`, `trend`) come out
 * null, because no history exists yet and null is what the contract says to
 * write when we have not measured something. A row component built against
 * these fixtures therefore has to render the "we do not know" case first, which
 * is the right way round: it is also what every `web` row will look like
 * forever.
 *
 * This is not the shard builder. `bin/shards.ts` (Wave 1 C) writes all 80 into
 * `public/data/` with the real metrics; this writes two into `fixtures/` and is
 * kept because they will be regenerated whenever the shape changes.
 *
 * Usage: node bin/fixtures.ts [--list=golang,rust] [--out=fixtures]
 */
import * as D from "drizzle-orm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { byShelf, loadConfig, type ConfigEntry } from "../src/lib/config.ts";
import { db } from "../src/lib/db/client.ts";
import { awesomeItemTable, targetTable } from "../src/lib/db/schema.ts";
import { targetHost } from "../src/lib/targets.ts";
import type { FrontPage, ListShard, Row } from "../src/lib/contracts.ts";

const { values: flags } = parseArgs({
  options: {
    list: { type: "string", default: "golang" },
    out: { type: "string", default: "fixtures" },
  },
});

/**
 * Where entries that sit above every heading are filed.
 *
 * 1,123 rows carry an empty `section_slug`, nearly all of them
 * `uhub/awesome-javascript`, which lists everything in its preamble and never
 * writes a heading at all. A shard's sections are its table of contents, and a
 * section with no name is not a thing a reader can be sent to, so they get one.
 * Checked against the real slugs of the same list below rather than assumed
 * free.
 */
const UNCATEGORIZED_SLUG = "uncategorized";
const UNCATEGORIZED_PATH = ["Uncategorized"];

const seconds = (at: Date | null) =>
  at === null ? null : Math.floor(at.getTime() / 1000);

type Entry = {
  target: typeof targetTable.$inferSelect;
  section: string[];
  sectionSlug: string;
  title: string | null;
  note: string | null;
  position: number;
  listId: string;
};

/**
 * Everything one config entry features, as rows plus a table of contents.
 *
 * Inner join, so an entry pointing at a repository GitHub has since deleted is
 * dropped: it has no url, no name and nothing to render, and it never got a
 * `target` row in the first place. The gap is not small (awesome-go writes
 * 3,044 entries and 2,829 of them resolve), and it is the same gap the old site
 * had, for the same reason.
 */
async function shardFor(entry: ConfigEntry): Promise<ListShard> {
  const rows = (await db
    .select({
      target: targetTable,
      section: awesomeItemTable.section,
      sectionSlug: awesomeItemTable.sectionSlug,
      title: awesomeItemTable.title,
      note: awesomeItemTable.note,
      position: awesomeItemTable.position,
      listId: awesomeItemTable.listId,
    })
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .where(D.inArray(awesomeItemTable.listId, entry.sourceIds))) as Entry[];

  /*
   * Curator order, which is the order the shard is stored in and the default
   * order of the page. Source first: a merged entry holds one position per
   * README and neither is *the* position, so the first curator's sequence runs
   * whole before the second's begins rather than the two interleaving into an
   * order neither of them wrote.
   */
  const sourceRank = new Map(entry.sourceIds.map((id, i) => [id, i]));
  rows.sort(
    (a, b) =>
      (sourceRank.get(a.listId) ?? 0) - (sourceRank.get(b.listId) ?? 0) ||
      a.position - b.position,
  );

  /*
   * Group by section, in the order each section first appears.
   *
   * Cutting a new section wherever the slug changes would be simpler and would
   * be wrong three times in the corpus: `alebcay/awesome-shell` and
   * `sorrycc/awesome-javascript` both scatter their headingless entries through
   * the README, and `lauris/awesome-scala` writes two headings that slugify to
   * "misc". Those lists would get the same slug twice in their table of
   * contents. Grouping instead keeps the contract (each slug once, each
   * section a contiguous slice) and moves at most a handful of rows out of
   * strict README order, inside a list that has already told us it does not
   * care where they go.
   */
  const groups = new Map<string, { path: string[]; entries: Entry[] }>();
  for (const row of rows) {
    const slug = row.sectionSlug === "" ? UNCATEGORIZED_SLUG : row.sectionSlug;
    const path = row.sectionSlug === "" ? UNCATEGORIZED_PATH : row.section;
    const group = groups.get(slug) ?? { path, entries: [] };
    group.entries.push(row);
    groups.set(slug, group);
  }
  const real = new Set(rows.map((r) => r.sectionSlug));
  if (real.has("") && real.has(UNCATEGORIZED_SLUG)) {
    throw new Error(
      `${entry.slug}: a heading slugifies to "${UNCATEGORIZED_SLUG}", which is ` +
        `where this list's headingless entries are filed; rename the bucket`,
    );
  }

  const shardRows: Row[] = [];
  const sections: ListShard["sections"] = [];
  for (const [slug, group] of groups) {
    const from = shardRows.length;
    for (const row of group.entries) shardRows.push(toRow(row));
    sections.push({ slug, path: group.path, from, to: shardRows.length });
  }

  const crawledAt = rows.reduce(
    (max, row) => Math.max(max, seconds(row.target.refreshedAt) ?? 0),
    0,
  );

  return {
    slug: entry.slug,
    name: entry.name,
    icon: entry.icon ?? "",
    sources: entry.sourceIds.map((id, i) => ({
      id,
      url: entry.url[i] ?? `https://github.com/${id}`,
    })),
    crawledAt,
    sections,
    rows: shardRows,
  };
}

/** one appearance of one target, as the tuple `contracts.ts` describes */
function toRow(row: Entry): Row {
  const t = row.target;
  const github = t.kind === "github";
  /*
   * A repository is named by its id: the owner sits in the id, the name is
   * what the row prints beside it, and that is the form you type into a package
   * manager. Anything else has only what the curator called it, and failing
   * that its host: "https://gtkmm.org/en" is an address, not a name.
   */
  const title = github
    ? (t.id.split("/")[1] ?? t.id)
    : (row.title ?? targetHost(t.url));

  return [
    t.id,
    title,
    row.note,
    github ? "github" : "web",
    t.url,
    row.position,
    t.stars,
    t.primaryLanguage,
    t.license,
    t.archived ? 1 : 0,
    seconds(t.lastActivityAt),
    // d7, d30, d365, state, and the three acceleration scores (30d, 7d, 1y).
    // No star history exists here at all; null is "not measured", never zero.
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
}

/**
 * The front page, with the three rubrics that need star history left empty.
 *
 * `climbing`, `entered` and `archived` are all differences (against last week,
 * against the previous crawl), and nothing here has a previous state to be
 * different from yet. They are emitted as empty rather than filled with
 * plausible-looking rows: a fixture that invents figures is a fixture somebody
 * ends up shipping. The list index below them is real, and is most of the page.
 */
async function frontPage(entries: ConfigEntry[]): Promise<FrontPage> {
  /*
   * Counted as rows, not as distinct projects, which is the one thing this
   * number has to get right: it is a promise about the page it links to. A
   * shard holds one row per *appearance*, so a target filed under two headings
   * is two rows there and has to be two here (five of them in awesome-go
   * alone). The old site counted distinct targets because its list page
   * deduplicated them; this one does not.
   */
  const counts = await db
    .select({
      listId: awesomeItemTable.listId,
      kind: targetTable.kind,
      n: D.sql<number>`count(*)`,
    })
    .from(awesomeItemTable)
    .innerJoin(targetTable, D.eq(targetTable.id, awesomeItemTable.targetId))
    .groupBy(awesomeItemTable.listId, targetTable.kind);

  const bySource = new Map<string, { entries: number; repos: number }>();
  for (const row of counts) {
    const tally = bySource.get(row.listId) ?? { entries: 0, repos: 0 };
    tally.entries += row.n;
    if (row.kind === "github") tally.repos += row.n;
    bySource.set(row.listId, tally);
  }

  const lists: FrontPage["lists"] = [];
  for (const entry of entries) {
    const total = { entries: 0, repos: 0 };
    for (const id of entry.sourceIds) {
      const tally = bySource.get(id);
      if (!tally) continue;
      total.entries += tally.entries;
      total.repos += tally.repos;
    }
    if (total.entries === 0) continue;
    lists.push({
      slug: entry.slug,
      name: entry.name,
      icon: entry.icon ?? "",
      group: entry.group,
      ...total,
    });
  }
  lists.sort(byShelf);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    climbing: [
      { period: "7d", rows: [] },
      { period: "30d", rows: [] },
      { period: "1y", rows: [] },
    ],
    entered: [],
    archived: [],
    lists,
  };
}

async function write(file: string, value: unknown) {
  // compact, like the shards the build will ship: the fixture is also the
  // measurement that the largest list fits in a page load
  const json = JSON.stringify(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, json + "\n");
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(
    `${file}: ${kb(Buffer.byteLength(json))} raw, ` +
      `${kb(gzipSync(json, { level: 9 }).byteLength)} gzipped`,
  );
}

const entries = await loadConfig();
const wanted = flags.list.split(",").map((s) => s.trim());

for (const slug of wanted) {
  const entry = entries.find((e) => e.slug === slug);
  if (!entry) throw new Error(`no list "${slug}" in config.yaml`);
  const shard = await shardFor(entry);
  console.log(
    `${shard.slug}: ${shard.rows.length} rows, ${shard.sections.length} sections`,
  );
  await write(path.join(flags.out, `${slug}.json`), shard);
}

await write(path.join(flags.out, "front-page.json"), await frontPage(entries));
