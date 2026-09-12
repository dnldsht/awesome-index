/**
 * Builds the whole site's data: one JSON shard per list, plus the front page.
 *
 * This is the only thing between the database and the browser. `nuxt generate`
 * prerenders 80 skeletons; each one fetches `public/data/<slug>.json` and does
 * every sort, filter and search the site offers against that array in memory.
 * There is no server, no pagination and no second request, so whatever this
 * file writes is, quite literally, the site.
 *
 * Three rules govern how rows become a shard. All three were established by
 * `bin/fixtures.ts` in Wave 0, all three are load-bearing, and each one is
 * documented where it is applied below:
 *
 *   1. inner-join to `target`, which drops entries pointing at repositories
 *      GitHub no longer serves (215 of them in awesome-go alone);
 *   2. rows in curator order — source first, then position — because that is
 *      the default order of the page and the only honest order for the 88% of
 *      non-GitHub entries that carry no popularity signal at all;
 *   3. group by section rather than cutting wherever the slug changes, so a
 *      slug appears exactly once in the table of contents.
 *
 * `fixtures/golang.json` is the regression test for all three: this writes
 * `public/data/golang.json`, and the two files must be byte-identical.
 *
 * Usage: node bin/shards.ts [--only=golang,rust] [--out=public/data]
 */
import * as D from "drizzle-orm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { loadConfig, type ConfigEntry } from "../src/lib/config.ts";
import { db } from "../src/lib/db/client.ts";
import {
  awesomeItemTable,
  starHistoryTable,
  targetTable,
} from "../src/lib/db/schema.ts";
import { targetHost } from "../src/lib/targets.ts";
import {
  ROW,
  type ActivityState,
  type ActivityStates,
  type FrontPage,
  type ListShard,
  type Ref,
  type Row,
  type TrendScore,
} from "../src/lib/contracts.ts";
import { trendScore as realTrendScore } from "../src/lib/trending.ts";
import { activityStates as realActivityStates } from "../src/lib/activity.ts";

const { values: flags } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string", default: "public/data" },
  },
});

/* -------------------------------------------------------------------------- */
/* metrics                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * Wave 1 B owns `src/lib/trending.ts` and `src/lib/activity.ts`. Until they
 * land these are stubs, typed against the aliases in `contracts.ts` so that the
 * compiler refuses a stub that does not have the real signature. Note that
 * `contracts.ts` declares those two functions rather than defining them — they
 * are erased at runtime, so importing them from there yields `undefined` and
 * would fail silently. Swapping a stub for the real thing is deleting one line
 * and adding one import; nothing else in this file changes.
 */
const trendScore: TrendScore = realTrendScore;
const activityStates: ActivityStates = realActivityStates;

/**
 * How many of the most recent weeks each window sums.
 *
 * The history is weekly — `star_history` stores one net delta per GitHub week
 * bucket — so a window is a count of weeks and not a count of days: 4 weeks is
 * 28 days and 52 is 364, and pretending otherwise would be precision we do not
 * have. Counting back from the newest week we hold rather than from `now` also
 * keeps the figures stable when a build runs a day or two after the fetch.
 *
 * The assumption that makes "+412 this week" true is the weekly refresh (page 1
 * with `If-None-Match`, see `PLAN.md` wave 3). If that job stops running, these
 * stay the last weeks we hold and quietly become older than their labels.
 */
const WINDOW_WEEKS = { d7: 1, d30: 4, d365: 52 } as const;

type Metrics = {
  d7: number | null;
  d30: number | null;
  d365: number | null;
  trend: number | null;
};

const NO_METRICS: Metrics = { d7: null, d30: null, d365: null, trend: null };

/**
 * The last `weeks` weeks summed, or null when we do not hold that many.
 *
 * Null rather than a short sum, because the two claims differ: a repository
 * that gained nothing over the year and one whose history only reaches back
 * four months are not the same row, and the second must not print a delta that
 * silently describes a shorter window than its label. This is the contract's
 * "or one younger than the window".
 */
function windowSum(weekly: number[], weeks: number): number | null {
  if (weekly.length < weeks) return null;
  let total = 0;
  for (let i = weekly.length - weeks; i < weekly.length; i++) {
    total += weekly[i] ?? 0;
  }
  return total;
}

/**
 * Every repository's history-derived numbers, keyed by `target.id`.
 *
 * Computed once for the whole corpus rather than once per list: a repository
 * linked by six lists has one history and must show the same figures in all
 * six. The table is scanned in primary-key order — `(targetId, week)` — so each
 * repository's deltas arrive contiguous and oldest-first, which is exactly the
 * shape `trendScore` wants, and the array is folded into four numbers at each
 * boundary rather than kept.
 *
 * `star_history` is empty until Wave 1 A's fetcher has run. That is not a
 * degraded mode to be worked around: it is the permanent state of all 11,491
 * `web` rows, so the null path is the one the row component has to render
 * first.
 */
async function loadMetrics(): Promise<Map<string, Metrics>> {
  const history = await db
    .select()
    .from(starHistoryTable)
    .orderBy(starHistoryTable.targetId, starHistoryTable.week);

  const metrics = new Map<string, Metrics>();
  let current: string | null = null;
  let weekly: number[] = [];

  const flush = () => {
    if (current === null) return;
    metrics.set(current, {
      d7: windowSum(weekly, WINDOW_WEEKS.d7),
      d30: windowSum(weekly, WINDOW_WEEKS.d30),
      d365: windowSum(weekly, WINDOW_WEEKS.d365),
      trend: trendScore(weekly),
    });
  };

  for (const row of history) {
    if (row.targetId !== current) {
      flush();
      current = row.targetId;
      weekly = [];
    }
    weekly.push(row.delta);
  }
  flush();

  return metrics;
}

/**
 * The activity label for every repository in the dataset.
 *
 * Handed the whole population in one call because the thresholds are
 * percentiles *within a language cohort* — see `activityStates` — which cannot
 * be computed from one list, and which must not be computed per list either:
 * "stalled" would then mean something different on every page it appeared on.
 */
async function loadActivity(): Promise<Map<string, ActivityState>> {
  const repos = await db
    .select({
      id: targetTable.id,
      language: targetTable.primaryLanguage,
      lastActivityAt: targetTable.lastActivityAt,
      archived: targetTable.archived,
    })
    .from(targetTable)
    .where(D.eq(targetTable.kind, "github"));

  return activityStates(
    repos.map((repo) => ({
      id: repo.id,
      language: repo.language,
      lastActivityAt: seconds(repo.lastActivityAt),
      archived: repo.archived ?? false,
    })),
  );
}

/* -------------------------------------------------------------------------- */
/* shards                                                                     */
/* -------------------------------------------------------------------------- */

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

type Derived = {
  metrics: Map<string, Metrics>;
  states: Map<string, ActivityState>;
};

/**
 * Everything one config entry features, as rows plus a table of contents.
 *
 * Inner join, so an entry pointing at a repository GitHub has since deleted is
 * dropped: it has no url, no name and nothing to render, and it never got a
 * `target` row in the first place. The gap is not small — awesome-go writes
 * 3,044 entries and 2,829 of them resolve — and it is the same gap the old site
 * had, for the same reason.
 */
async function shardFor(
  entry: ConfigEntry,
  derived: Derived,
): Promise<{ shard: ListShard; keys: number[] }> {
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
   * contents. Grouping instead keeps the contract — each slug once, each
   * section a contiguous slice — and moves at most a handful of rows out of
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
  // the sort key of each emitted row, kept alongside so `validate` can prove
  // the grouping did not disturb the curator's order; it is not shipped
  const keys: number[] = [];
  for (const [slug, group] of groups) {
    const from = shardRows.length;
    for (const row of group.entries) {
      keys.push((sourceRank.get(row.listId) ?? 0) * 1e9 + row.position);
      shardRows.push(toRow(row, derived));
    }
    sections.push({ slug, path: group.path, from, to: shardRows.length });
  }

  const crawledAt = rows.reduce(
    (max, row) => Math.max(max, seconds(row.target.refreshedAt) ?? 0),
    0,
  );

  return {
    shard: {
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
    },
    keys,
  };
}

/** one appearance of one target, as the tuple `contracts.ts` describes */
function toRow(row: Entry, derived: Derived): Row {
  const t = row.target;
  const github = t.kind === "github";
  /*
   * A repository is named by its id — the owner sits in the id, the name is
   * what the row prints beside it, and that is the form you type into a package
   * manager. Anything else has only what the curator called it, and failing
   * that its host: "https://gtkmm.org/en" is an address, not a name.
   */
  const title = github
    ? (t.id.split("/")[1] ?? t.id)
    : (row.title ?? targetHost(t.url));

  /*
   * Null on every axis for a `web` row and for any repository the fetcher has
   * not reached yet, which today is all of them. Null is not zero: "gained
   * nothing" and "never measured" are different claims and the row renders them
   * differently.
   */
  const m = derived.metrics.get(t.id) ?? NO_METRICS;

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
    m.d7,
    m.d30,
    m.d365,
    derived.states.get(t.id) ?? null,
    m.trend,
  ];
}

/* -------------------------------------------------------------------------- */
/* invariants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the page is allowed to assume about a shard, asserted at build time.
 *
 * The list page reads `rows.slice(from, to)` per section and scrolls to a slug;
 * every one of these failing is a rendering bug that would show up as rows
 * missing from the page or a table of contents with a duplicate entry, several
 * hundred kilobytes into a file nobody reads by eye. Cheap to check here, and
 * this is the only place that can.
 */
function validate(shard: ListShard, keys: number[]) {
  const fail = (why: string) => {
    throw new Error(`${shard.slug}: ${why}`);
  };

  const seen = new Set<string>();
  let cursor = 0;
  for (const section of shard.sections) {
    if (seen.has(section.slug)) fail(`section "${section.slug}" appears twice`);
    seen.add(section.slug);
    if (section.from !== cursor) {
      fail(
        `section "${section.slug}" starts at ${section.from}, not ${cursor}`,
      );
    }
    if (section.to <= section.from) fail(`section "${section.slug}" is empty`);
    cursor = section.to;
  }
  if (cursor !== shard.rows.length) {
    fail(`sections cover ${cursor} of ${shard.rows.length} rows`);
  }

  /*
   * Curator order, checked inside each section rather than across the whole
   * array: grouping deliberately moves a non-contiguous section's later rows up
   * to join its earlier ones, so the key is monotonic within a slice and not
   * between slices. `keys` is (source index, position) as a single number,
   * which is the order the rows were sorted into and the only one a merged
   * list's two curators can be compared in.
   */
  for (const section of shard.sections) {
    for (let i = section.from + 1; i < section.to; i++) {
      if ((keys[i] ?? 0) < (keys[i - 1] ?? 0)) {
        fail(`section "${section.slug}" is not in curator order`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* front page                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How many rows each rubric carries.
 *
 * The front page is fetched before anything is on screen, so it is kept to a
 * few kilobytes: three climbing blocks and two difference blocks at this size
 * is under 10 KB of refs, and the list index below them is the rest.
 */
const TOP = 20;

/**
 * The home page: what is climbing, what has just arrived, what has just been
 * declared finished, and the index of all 80 lists.
 *
 * Two of the three rubrics are differences against a *previous state*, and this
 * is where that comes from:
 *
 * - `climbing` is a difference against the repository's own past, and the past
 *   is in `star_history`. It needs no snapshot; it is empty today only because
 *   the fetcher has not run yet, and it will fill in on its own.
 * - `entered` and `archived` are differences against the previous *crawl*, and
 *   nothing in the database records what the last crawl saw — `awesome_item` is
 *   overwritten in place, and a first-seen column would have to be added by
 *   whoever owns the schema. So the previous state is the previous build's own
 *   output: the shards already in `--out` are read before they are overwritten,
 *   and a row is `entered` when its id is not in the shard we are replacing.
 *   That makes the deploy job responsible for restoring `public/data/` next to
 *   the dataset it already restores (`PLAN.md` wave 3) — one more release asset
 *   or a checkout of the published branch. Until it does, every build sees no
 *   previous state and both rubrics are empty, which is the correct answer to
 *   "what changed since a crawl we have no record of".
 *
 * They are emitted empty rather than filled with plausible-looking rows. A
 * front page that invents a difference is a front page that lies every day
 * until somebody notices.
 */
function frontPage(shards: ListShard[], previous: Map<string, PrevShard>) {
  const climbing: FrontPage["climbing"] = [];
  for (const [period, index] of [
    ["7d", ROW.D7],
    ["30d", ROW.D30],
    ["1y", ROW.D365],
  ] as const) {
    const candidates: (Ref & { trend: number })[] = [];
    for (const shard of shards) {
      for (const row of shard.rows) {
        const value = row[index];
        const trend = row[ROW.TREND];
        // `trend` orders and is never rendered; `value` is a count of real
        // stars and is the only number that reaches the page
        if (trend === null || value === null) continue;
        candidates.push({
          listSlug: shard.slug,
          id: row[ROW.ID],
          title: row[ROW.TITLE],
          value,
          trend,
        });
      }
    }
    candidates.sort((a, b) => b.trend - a.trend);
    climbing.push({ period, rows: best(candidates) });
  }

  const entered: Ref[] = [];
  const archived: Ref[] = [];
  for (const shard of shards) {
    const before = previous.get(shard.slug);
    if (!before) continue;
    for (const row of shard.rows) {
      const ref = {
        listSlug: shard.slug,
        id: row[ROW.ID],
        title: row[ROW.TITLE],
        value: row[ROW.STARS] ?? 0,
      };
      const was = before.get(row[ROW.ID]);
      if (was === undefined) entered.push(ref);
      else if (was === 0 && row[ROW.ARCHIVED] === 1) archived.push(ref);
    }
  }
  entered.sort((a, b) => b.value - a.value);
  archived.sort((a, b) => b.value - a.value);

  /*
   * Counted off the shards themselves, not with a second query, which is the
   * one thing this number has to get right: it is a promise about the page it
   * links to. A shard holds one row per *appearance*, so a target filed under
   * two headings is two rows there and has to be two here — five of them in
   * awesome-go alone — and a count that came from anywhere else could disagree.
   */
  const lists = shards.map((shard) => ({
    slug: shard.slug,
    name: shard.name,
    icon: shard.icon,
    entries: shard.rows.length,
    repos: shard.rows.filter((row) => row[ROW.KIND] === "github").length,
  }));
  lists.sort((a, b) => b.entries - a.entries);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    climbing,
    entered: best(entered),
    archived: best(archived),
    lists,
  } satisfies FrontPage;
}

/**
 * The top `TOP`, one per project.
 *
 * Deduplicated by id because a project linked by six lists is one row in each
 * of their shards, and six rows for `ollama/ollama` is not a front page. The
 * first occurrence wins, which after the sort is its best-placed appearance.
 */
function best(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push({
      listSlug: ref.listSlug,
      id: ref.id,
      title: ref.title,
      value: ref.value,
    });
    if (out.length === TOP) break;
  }
  return out;
}

/** id -> archived, from the shard this build is about to replace */
type PrevShard = Map<string, 0 | 1>;

/**
 * The previous build's shards, as the little of them the two difference rubrics
 * need. Absent, unreadable or malformed is not an error: it means this is the
 * first build here, and the answer to "what changed" is then "we cannot say".
 */
async function loadPrevious(
  out: string,
  slugs: string[],
): Promise<Map<string, PrevShard>> {
  const previous = new Map<string, PrevShard>();
  for (const slug of slugs) {
    try {
      const raw = await fs.readFile(path.join(out, `${slug}.json`), "utf8");
      const shard = JSON.parse(raw) as ListShard;
      const ids: PrevShard = new Map();
      for (const row of shard.rows) ids.set(row[ROW.ID], row[ROW.ARCHIVED]);
      previous.set(slug, ids);
    } catch {
      continue;
    }
  }
  return previous;
}

/* -------------------------------------------------------------------------- */
/* writing                                                                    */
/* -------------------------------------------------------------------------- */

const kb = (n: number) => n / 1024;

/**
 * Compact JSON, always. This output is fetched on page load, so a pretty
 * printer would triple it; `.prettierignore` has to keep its hands off
 * `public/data/` for the same reason it already does off `fixtures/`.
 */
async function write(file: string, value: unknown): Promise<number> {
  const json = JSON.stringify(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, json + "\n");
  return gzipSync(json, { level: 9 }).byteLength;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

const config = await loadConfig();
const only = flags.only?.split(",").map((s) => s.trim());
const entries = only
  ? only.map((slug) => {
      const entry = config.find((e) => e.slug === slug);
      if (!entry) throw new Error(`no list "${slug}" in config.yaml`);
      return entry;
    })
  : config;

const derived: Derived = {
  metrics: await loadMetrics(),
  states: await loadActivity(),
};
console.log(
  `metrics: ${derived.metrics.size} repositories with history, ` +
    `${derived.states.size} with an activity state`,
);

const previous = await loadPrevious(
  flags.out,
  entries.map((e) => e.slug),
);

const shards: ListShard[] = [];
const sizes: { slug: string; gz: number }[] = [];
for (const entry of entries) {
  const { shard, keys } = await shardFor(entry, derived);
  /*
   * A config entry with nothing behind it gets no shard: `config.yaml` has 80
   * entries and `awesome_list` has 88 rows, the extra seven being the second
   * README of a merged entry — plus `KotlinBy/awesome-kotlin`, which is no
   * longer in the config and parsed to zero items. A shard with no rows is a
   * page with nothing on it and a 404 waiting to happen, so it is skipped
   * loudly rather than written empty.
   */
  if (shard.rows.length === 0) {
    console.warn(`${entry.slug}: no rows, skipped`);
    continue;
  }
  validate(shard, keys);
  shards.push(shard);
  const gz = await write(path.join(flags.out, `${shard.slug}.json`), shard);
  sizes.push({ slug: shard.slug, gz });
}

const front = await write(
  path.join(flags.out, "front-page.json"),
  frontPage(shards, previous),
);

sizes.sort((a, b) => b.gz - a.gz);
const total = sizes.reduce((sum, s) => sum + s.gz, 0);
const median = sizes[Math.floor(sizes.length / 2)];
console.log(
  `\n${shards.length} shards, ${kb(total).toFixed(0)} KB gzipped in total`,
);
for (const { slug, gz } of sizes.slice(0, 5)) {
  console.log(`  ${slug.padEnd(24)} ${kb(gz).toFixed(1)} KB`);
}
console.log(`  ${"…".padEnd(24)} median ${kb(median?.gz ?? 0).toFixed(1)} KB`);
console.log(`  front-page.json          ${kb(front).toFixed(1)} KB`);

// the whole rewrite rests on the largest list fitting in a page load; if it
// stops fitting, that is a design decision to revisit and not a warning to skim
const LIMIT = 200 * 1024;
const largest = sizes[0];
if (largest && largest.gz > LIMIT) {
  throw new Error(
    `${largest.slug} is ${kb(largest.gz).toFixed(1)} KB gzipped, over the ` +
      `${kb(LIMIT)} KB budget a shard has to fit in`,
  );
}
