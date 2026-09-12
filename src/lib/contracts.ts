/**
 * The shapes that cross a boundary in v2, and nothing else.
 *
 * Everything the site ships to a browser is described here: one JSON document
 * per list, one for the front page, and the two function signatures that turn
 * star history into the numbers a row carries. This file is what makes the rest
 * of the work parallel — the fetcher, the metrics, the shard builder and the
 * pages are written against these types rather than against each other — so it
 * has no imports, no runtime behaviour and no dependencies. It is a contract,
 * and it is meant to be read in full before anything is written against it.
 *
 * Read `DESIGN.md` first. Several decisions below look wrong at a glance and
 * are deliberate; the ones that have caught people already are called out where
 * they live.
 */

/* -------------------------------------------------------------------------- */
/* rows                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One entry of one list, as it travels.
 *
 * A tuple, not an object. `avelino/awesome-go` is the worst case in the corpus
 * at ~3,000 entries, and sixteen keys repeated three thousand times is the bulk
 * of the document: the field names would outweigh the data they name. Gzip
 * forgives a lot of that, but not all of it, and the whole rewrite rests on the
 * largest shard staying small enough to send on page load. Positional access is
 * the price, and `ROW` below is how it stays readable — write `row[ROW.STARS]`,
 * never `row[6]`.
 *
 * The order of the fields is part of the contract. Appending is safe; inserting
 * or reordering silently reinterprets every shard that has already been built,
 * because a tuple carries no names to disagree with.
 *
 * A row is an *appearance*, not a project: the same target can be filed under
 * two headings of one list, and then it is two rows with the same `id`. A
 * project linked by two different lists is one row in each of their shards.
 */
export type Row = [
  /**
   * `target.id`: "<owner>/<name>" for a repository, a normalised URL for
   * everything else. Identity, and the join key back to the database — not a
   * display string, though a github id is also the form you type into a package
   * manager and is rendered as such.
   */
  id: string,
  /**
   * What to call the thing. For a `github` row, the repository name alone (the
   * owner is already in `id`, and the row renders the two together). For a
   * `web` row, what the curator wrote, falling back to the host — a URL is an
   * address, not a name, and those rows have no other name to offer.
   */
  title: string,
  /** the prose the curator wrote beside the link; ~67 bytes on average */
  note: string | null,
  kind: "github" | "web",
  /** where the row links to; leaves the site */
  url: string,
  /**
   * The curator's position in the README, which is the default order of the
   * list and the reason `rows` is stored the way it is.
   *
   * Not unique within a shard, and not a sort key on its own: a merged list
   * (MacOS is two READMEs) holds one position per source, and two curators
   * numbering from 1 interleave into nonsense. `rows` is already in the right
   * order — source first, then position — so the ordering that matters is the
   * array index. This field is here to be shown, not to sort by.
   *
   * **Zero-based.** The first entry of a README is `0`, so anything rendering
   * it as a rank writes `position + 1`.
   */
  position: number,
  /**
   * GitHub stars, and null for everything that cannot be starred. Null is not
   * zero: a repository with `stars: 0` has none, a website has no such notion,
   * and the row must not print a zero for the second case. The calibrated
   * star-equivalent that ranks the unstarrable rows (see `popularity.ts`) is
   * deliberately not in this tuple — it sorts, it is never shown, and no
   * ordering in v2 needs it yet.
   */
  stars: number | null,
  /** GitHub's primary language, as GitHub spells it */
  language: string | null,
  /** the licence GitHub reports, by its full name ("MIT License") */
  license: string | null,
  /**
   * The author declared the project finished or abandoned. Numeric because a
   * boolean costs four extra bytes per row in JSON, and 0 rather than null on a
   * `web` row: a website cannot be archived, so there is nothing to not know.
   */
  archived: 0 | 1,
  /**
   * `pushedAt` for a repository, in unix *seconds*. Null for a `web` row, which
   * has no pulse to report — again not zero, and not a date the reader should
   * be shown as 1970.
   *
   * Always rendered beside the `state` label, never instead of it: the label is
   * our judgement and the date is the fact it was made from, and a reader is
   * entitled to disagree with the first while looking at the second.
   */
  lastActivityAt: number | null,
  /**
   * Net stars gained over the window, from the weekly history. Null means we
   * have no history for this row — a `web` row, a repository the fetcher has
   * not reached, or one younger than the window — and null is not zero: a
   * project that gained nothing this week and a project we have never measured
   * are different claims.
   *
   * These are facts and they are displayed as such ("+412 this week"). The
   * score that *orders* them is `trend`, below, and it is not.
   */
  d7: number | null,
  d30: number | null,
  d365: number | null,
  /** see `ActivityState`; null when the cohort was too small to judge */
  state: ActivityState | null,
  /**
   * Acceleration against the repository's own baseline — see `trendScore`.
   *
   * **A SORT KEY. NEVER RENDERED.** It exists so "trending" can mean what a
   * reader means by it rather than "big", and it has no unit anybody could read.
   * The row shows `d7`/`d30`/`d365`, which are counts of actual stars. This is
   * the same rule `popularity.ts` sets for its star equivalents, for the same
   * reason: an ordering is a decision, a printed number is a claim.
   *
   * Null means not enough history to judge, or below the absolute floor. Those
   * rows sort last under a trend sort; they are not zeroes.
   */
  trend: number | null,
];

/**
 * Names for the positions in `Row`. Every read goes through this.
 *
 * Kept in the same order as the tuple above, and changed at the same time as
 * it — the compiler will not catch a constant that points one field to the
 * left, and the symptom is a language column full of licences.
 */
export const ROW = {
  ID: 0,
  TITLE: 1,
  NOTE: 2,
  KIND: 3,
  URL: 4,
  POSITION: 5,
  STARS: 6,
  LANGUAGE: 7,
  LICENSE: 8,
  ARCHIVED: 9,
  LAST_ACTIVITY: 10,
  D7: 11,
  D30: 12,
  D365: 13,
  STATE: 14,
  TREND: 15,
} as const;

/**
 * What we say about whether a project is still moving.
 *
 * Four words rather than a number of days, because the number of days means
 * different things in different languages: eighteen months without a commit is
 * abandonment for an npm package and completion for a C library. The thresholds
 * behind these labels are percentiles within the repository's own language
 * cohort, recomputed every crawl — see `activityStates`.
 *
 * `archived` is the only one of the four the project itself declared. The other
 * three are our inference, which is why the date is always shown next to them.
 */
export type ActivityState = "active" | "slow" | "stalled" | "archived";

/* -------------------------------------------------------------------------- */
/* shards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One list, whole. This is the unit the browser fetches and then sorts,
 * filters and searches in memory — there is no second request, no pagination
 * and no server. The median list is ~400 entries and the largest ~3,000, which
 * at this shape is a couple of hundred kilobytes gzipped: smaller than the hero
 * image the old site did not have.
 */
export type ListShard = {
  /** the URL segment: `/golang`, from `slugify(config.name)` */
  slug: string;
  /** the config entry's name, as written in `config.yaml` */
  name: string;
  /** the emoji from `config.yaml`; part of the masthead, not decoration */
  icon: string;
  /**
   * The READMEs this page is made of, in config order. Usually one. Seven
   * entries merge two lists (MacOS, JavaScript, dotNET, Scala, Shell, Haskell,
   * Perl), and then the order of this array is also the order the rows are in:
   * the first curator's sequence runs whole before the second's begins, because
   * interleaving two people's judgement produces an order neither of them wrote.
   */
  sources: { id: string; url: string }[];
  /** when the dataset behind this shard was last refreshed, unix seconds */
  crawledAt: number;
  /**
   * The curator's table of contents. `from`/`to` are indices into `rows`
   * (`rows.slice(from, to)`, so `to` is exclusive), which works because `rows`
   * is in curator order and a section is therefore a contiguous run.
   *
   * Two conventions a builder has to honour, both learned from the data:
   *
   * - Entries that sit above every heading — 1,123 of them, nearly all in
   *   `uhub/awesome-javascript`, which writes its whole list in the preamble —
   *   are filed under the slug `uncategorized` with the path `["Uncategorized"]`.
   *   The database stores `""` for those; a shard never does.
   * - A slug appears at most once in this array. Three (list, slug) pairs in the
   *   corpus are *not* contiguous in README order, because two headings
   *   slugified to the same thing or a curator returned to the same heading
   *   later. Rows are grouped by section — ordered by where the section first
   *   appears, then by position inside it — rather than cut wherever the slug
   *   changes, so the invariant holds for every list and the table of contents
   *   never lists "Misc" twice.
   *
   * With 4,350 sections across the corpus at a median of 6 entries, this is a
   * table of contents and not a filter: it is what the page scrolls to, and
   * what `content-visibility: auto` is applied per instance of.
   */
  sections: { slug: string; path: string[]; from: number; to: number }[];
  /**
   * Every entry of the list, in the curator's order. The default order of the
   * page, the one order the old site could not produce, and the only honest
   * order for the 88% of non-GitHub entries that carry no popularity signal at
   * all. Every other order is a `.sort()` in the browser over this array.
   */
  rows: Row[];
};

/* -------------------------------------------------------------------------- */
/* front page                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A pointer to one row of one shard, with the figure that earned it its place.
 *
 * The front page names projects that live in 80 different shards and cannot
 * load them; this is the little that has to be copied out. `value` is whatever
 * the rubric is about — net stars gained over the period for `climbing` — and
 * it is a count of real stars, so it can be printed. `listSlug` is where the
 * link goes.
 */
export type Ref = {
  listSlug: string;
  id: string;
  title: string;
  value: number;
};

/**
 * The home page, precomputed.
 *
 * The one part of the site that changes on its own every day, which is the
 * difference between a reference somebody consults once and a site they come
 * back to. It is an aggregate, not an index: the list index is the bottom of
 * the page, not the point of it.
 */
export type FrontPage = {
  generatedAt: number;
  /**
   * What is climbing, one block per window. Ordered by `trendScore` — the score
   * itself does not appear here, deliberately; `Ref.value` is the star count for
   * the period, which is the number a reader is shown.
   *
   * 30d is the default block. 7d is the only window that means *now* and is
   * noise as a default, because nobody visits an index of awesome lists weekly;
   * 1y answers the other question, whether a thing is growing or has stalled.
   */
  climbing: { period: "7d" | "30d" | "1y"; rows: Ref[] }[];
  /** newly present in a list since the previous crawl; `value` is its stars */
  entered: Ref[];
  /** the archived flag flipped on since the previous crawl; `value` is stars */
  archived: Ref[];
  /**
   * Every list, for the index. `entries` is the number of rows its shard
   * holds — the same count, so the index does not promise 2,824 and the page
   * then show 2,829 — and `repos` how many of those are repositories. The gap
   * between the two is the part of the list that has no stars and no pulse,
   * large enough on some lists (awesome-mac is half) that stating it is the
   * honest thing to do.
   */
  lists: {
    slug: string;
    name: string;
    icon: string;
    entries: number;
    repos: number;
  }[];
};

/* -------------------------------------------------------------------------- */
/* metrics                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * Declarations, not implementations. These two signatures exist here so that
 * the shard builder can be written against them before the functions are
 * written, and so that both sides cannot drift.
 *
 * They are `declare`, so they vanish at runtime: importing `trendScore` from
 * *this* file typechecks and then hands you `undefined`. The implementations
 * live in `src/lib/trending.ts` and `src/lib/activity.ts` and are what you
 * import. A builder that needs them before they land should stub them locally
 * and type the stub with `TrendScore` / `ActivityStates` below, so that
 * swapping in the real one is a change of import and nothing else.
 */

/**
 * How hard a repository is accelerating against its own past, or null.
 *
 * The question a reader means by "trending" is not "which of these is big" —
 * absolute deltas answer that, and we already have that order under stars.
 * Nor is it percentage growth, which ranks twelve stars going to thirty at
 * +150% forever. It is: this project normally gains three a week and gained
 * forty.
 *
 * `weekly` is oldest → newest, roughly 60 weeks of net deltas as stored in
 * `star_history`; values may be negative. `opts.floor` is the absolute number
 * of stars a recent window has to have gained before the row is allowed to
 * trend at all, which is what stops 3 → 9 outranking the entire corpus.
 *
 * Returns null when there is not enough history to judge, or when the floor is
 * not cleared. Null sorts last; it is not zero.
 *
 * **The value returned sorts and is never rendered.** See `Row`'s `trend`.
 */
export declare function trendScore(
  weekly: number[],
  opts?: {
    floor?: number;
    /**
     * How many weeks count as "recently", i.e. the width of the window whose
     * mean is compared against the baseline. Defaults to the 30-day window the
     * site defaults to.
     *
     * It has to be a parameter because `FrontPage.climbing` asks for three
     * orderings (7d / 30d / 1y) and one fixed window yields one. Slicing
     * `weekly` does not substitute for it: that shortens the baseline the
     * window is measured against, which is a different question and a worse
     * baseline.
     */
    weeks?: number;
  },
): number | null;

/**
 * The activity label for each repository, keyed by id.
 *
 * Takes the whole population rather than one repository at a time because the
 * thresholds are *percentiles within the language cohort*, computed from the
 * population handed in: "stalled" means in the bottom quartile of activity
 * among the projects in that language in this dataset. Fixed day thresholds
 * are systematically wrong about whole families of languages — see
 * `ActivityState` — and a self-calibrating cut asks nobody to believe a
 * hand-picked constant. `popularity.ts` solves the same shape of problem and is
 * worth reading first.
 *
 * `archived: true` short-circuits to `"archived"` whatever the dates say. A
 * language cohort too small to produce meaningful percentiles is left out of
 * the map entirely rather than ranked on noise, so a missing key is a real
 * answer and means "we do not know"; `Row`'s `state` is null for those.
 */
export declare function activityStates(
  repos: {
    id: string;
    language: string | null;
    lastActivityAt: number | null;
    archived: boolean;
  }[],
): Map<string, ActivityState>;

/** the shape of `src/lib/trending.ts`'s export, for stubs and for tests */
export type TrendScore = typeof trendScore;

/** the shape of `src/lib/activity.ts`'s export, for stubs and for tests */
export type ActivityStates = typeof activityStates;
