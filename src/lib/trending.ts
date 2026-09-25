/**
 * Deciding which projects are climbing, when every honest answer is relative.
 *
 * "Trending" has two obvious implementations and both of them are already
 * orders this site has, or orders nobody wants:
 *
 *   absolute delta    React gains ~400 stars a week standing still, so the
 *                     column sorts by size. That is the stars column with more
 *                     arithmetic in front of it.
 *   percent growth    twelve stars to thirty is +150%, and it is +150% every
 *                     time a single person with a large following links it. The
 *                     column sorts by smallness instead.
 *
 * What a reader means by trending is neither: *this project normally gains
 * three stars a week and gained forty*. That is a statement about a repository
 * against its own past, and it is the same move `popularity.ts` makes for a
 * different quantity: rank a value inside the only population it is
 * comparable with, rather than against a scale borrowed from somewhere else.
 * There the cohort is a forge or a registry; here the cohort is the
 * repository's own sixty weeks of history, which is the one population whose
 * units are guaranteed to match.
 *
 * So the score is a distance: how far the last four weeks sit above what this
 * repository's weeks normally do, measured in units of how much its weeks
 * normally vary. Both of those are medians rather than means, which matters
 * more here than it usually does: star history is spiky by construction (one
 * front page, one newsletter, one conference talk), and a mean baseline lets a
 * single past spike raise the bar high enough to hide the present one, while a
 * standard deviation computed over that same spike widens the denominator
 * until nothing can ever clear it. A median and a median absolute deviation
 * ignore a handful of loud weeks, which is exactly the right instinct about a
 * measure of what is normal.
 *
 * Two guards keep the relative measure from saying something silly, and they
 * are the same two guards `popularity.ts` uses: an absolute floor below which
 * a row is not eligible at all, because three stars to nine is a 300% week and
 * means nothing; and a minimum amount of history below which no answer is
 * given, because a repository six weeks old has no "normally" to be measured
 * against; every week of it is its launch.
 *
 * **The value returned sorts and is never rendered.** `contracts.ts` says so at
 * `Row[ROW.TREND]` and it is worth repeating here, where the number is made: it
 * has no unit a reader could check, and a number with no unit printed next to a
 * project name is a claim nobody can argue with. The row shows `+412 this
 * week`, which is a count of actual stars and a fact. This ordering is a
 * decision; the rendered figure is the evidence for it.
 */

/**
 * The window that counts as "now", when the caller does not say.
 *
 * Four weeks, because 30d is the window the site defaults to (`DESIGN.md`,
 * "Trending"): seven days is the only window that means *now* and is noise as a
 * default, since nobody visits an index of awesome lists weekly. One week of
 * history is also one sample, and one sample cannot be told apart from the
 * spikiness the median is there to absorb, which is why `opts.weeks` of 1 is
 * allowed, for the 7d rubric that asks for exactly that, and is not the default
 * anybody gets by saying nothing.
 */
export const RECENT_WEEKS = 4;

/**
 * How much history a repository needs before it is judged at all.
 *
 * The baseline is every week *before* the recent window, and eight of them is
 * two months: short, but the alternative is worse than a short baseline. A
 * repository younger than this is living its launch: its first weeks are the
 * largest it will have for a long time, so it would either read as violently
 * decelerating or, once the launch scrolled out of the window, as accelerating
 * against a normality that never existed. There is no answer to give, and the
 * shape of "no answer" in this codebase is null rather than a number nobody
 * can defend. That is the same choice `popularity.ts` makes for a cohort of four.
 *
 * The fetcher stores sixty weeks at the default two-page depth (`DESIGN.md`,
 * "Depth: 14 months"). Exactly sixty, measured: 162 of the 165 backfilled
 * kubernetes repositories hold 60 rows and none holds fewer. So for the
 * default four-week window this bites only on the 1,883 repositories (5.4% of
 * 34,808) that are younger than the backfill is deep. **Those returning null is
 * expected and correct**, not a gap in the crawl: a repository with fourteen
 * weeks of life has no year to be compared against.
 */
export const MIN_BASELINE_WEEKS = 8;

/**
 * How much baseline a window of `weeks` needs before the comparison is honest.
 *
 * `MIN_BASELINE_WEEKS` alone is not enough once the window is a parameter, and
 * the 1y rubric is where that stops being theoretical. At the default depth a
 * repository holds exactly 60 weeks, so `weeks: 52` leaves a baseline of
 * exactly 8: the absolute minimum, cleared by zero weeks, and a minimum that
 * was chosen for a four-week window in a sixty-week history, where it describes
 * a rare young repository rather than the operating point of an entire rubric.
 *
 * Two things are wrong with a 52-on-8 comparison, and neither is fixed by the
 * numbers happening to fit:
 *
 * - The baseline is the noisy half. The window's mean averages `weeks` samples
 *   and is stable; the baseline supplies both the centre the window is compared
 *   against *and* the spread it is divided by, and a median absolute deviation
 *   over eight weeks is a soft number in the denominator of every score. The
 *   ranking would be substantially a ranking of which repositories had a quiet
 *   fortnight fourteen months ago.
 * - It inverts the sentence. "Normally gains three a week and gained forty" is
 *   only a claim about the present if "normally" covers a longer stretch than
 *   "recently" does. Eight weeks against fifty-two is an anecdote being used as
 *   a ruler, and the honest reading of it is the other way round.
 *
 * So the baseline must also be at least half the window. Half rather than the
 * full 1:1 because the two sides are not estimating the same thing: the
 * window is stable by construction, and demanding symmetry would price the 1y
 * rubric at four pages of backfill to buy precision the numerator does not
 * need. Half is where the baseline is a comparable stretch of the repository's
 * life rather than the tail end of one.
 *
 * What that costs, in the only place it binds:
 *
 *   window   baseline needed   history needed   pages
 *   7d  (1)        8                 9            1
 *   30d (4)        8                12            1
 *   1y  (52)      26                78            3
 *
 * **At the planned two-page depth, `weeks: 52` returns null for every
 * repository in the corpus** (60 weeks is 18 short of 78), so the 1y block of
 * the front page would be empty rather than wrong. That is the deliberate
 * behaviour and it is the answer to the question: a year-long window is a
 * request this function declines until there is a year of history behind the
 * year it is measuring. Three pages (90 weeks) gives it a 38-week baseline,
 * which is a baseline; the cost is a known 32,187 requests and no new code.
 */
export function minBaselineFor(weeks: number): number {
  return Math.max(MIN_BASELINE_WEEKS, Math.ceil(weeks / 2));
}

/**
 * Stars the recent window must have gained before a row may trend at all.
 *
 * **A hundred stars in four weeks, which is six times the median four-week
 * gain of 17** measured across the 1,213 repositories backfilled on
 * 2026-09-13 (`select` the last four weeks of `star_history` per repository and
 * take the median of the sums; that is the whole recomputation). The multiple
 * is recorded so the number can be carried to a corpus of a different size,
 * not because it is re-derived per crawl. It must not be: this floor reorders
 * every list page's trending sort, so it changes when somebody decides it
 * should, not when a backfill lands. A percentile would have moved three times
 * in two days as the corpus grew from 185 repositories to 1,213.
 *
 * The reason it has to be this large is `MIN_SPREAD`, and the two constants
 * should be read together. For a repository with a flat baseline (every week
 * zero, which is most of the corpus), the median is 0 and the spread is pinned
 * at 1, so the score collapses to `gained / weeks`: the raw rate, with no
 * normalisation left in it. For that whole class the floor is not a gate in
 * front of the ranking, **it is the ranking**, because such a row enters at
 * exactly `floor / weeks` and every one of them scores at least that.
 *
 * So the floor is answering one editorial question: *what is the smallest gain
 * that may take a top slot on the strength of having come from nothing?* Ratio
 * cannot answer it (zero to anything is an infinite acceleration), and that is
 * precisely why an absolute number is the only thing that can.
 *
 * The old value of 25 answered it badly, and the damage is measurable. It
 * admitted 533 of 1,213 repositories (44%), which is not a gate; worse, all
 * twelve of the standing-start repositories it let through gained between 25
 * and 60 stars, scored 6.5 to 14.3, and landed *interleaved with the real
 * climbers*: +58, +57 and +54 from nothing sat at ranks 9, 10 and 11, above
 * `makeplane/plane` at +3,403 against a baseline of 207 a week. Measured on the
 * same corpus, the band from 60 to 100 contains no standing starts at all, and
 * the first one above 100 gained 138 from a standing stop, which is a genuine
 * story and is kept.
 *
 * Two independent readings put the number in the same place, which is most of
 * why it is this one:
 *
 * - Six times the median gain is 102.
 * - A standing start enters at `floor / 4` = 25, and 25 is where the *measured*
 *   scores of repositories that have a real baseline top out (the best in the
 *   corpus score 62.8, 27.8, 25.2, 24.7, 17.4 …, and only two of 237 exceed
 *   25). So a row that came from nothing enters at parity with the best climb
 *   we can actually measure, rather than above all of them.
 *
 * Note the direction, because it is counter-intuitive and worth not
 * rediscovering: *raising* the floor raises where the standing-start class
 * enters, since its minimum score is `floor / weeks`. It buys its ordering by
 * making the class rarer, not by demoting it. That is the argument against
 * going further: at 170 the class is empty on this corpus and the first
 * repository to clear it later will enter at 42, above everything.
 *
 * Still deliberately a noise gate and not a ranking device: above it the
 * ordering is the score's job alone, and raising it until only substantial
 * repositories survive would reintroduce through the back door precisely the
 * "trending means big" ordering this file exists to avoid. It nulls 80% of the
 * backfilled corpus, against 86% at 170 and 56% at the old 25.
 *
 * The front page passes its own, larger floors and should: a 20-row block only
 * has to be right about 20 rows, so it can afford to exclude everything
 * marginal, while this default governs `Row[ROW.TREND]` and therefore a
 * `sort=trending` that has to produce a sensible order for *every* row of all
 * 80 lists. That is what the parameter is for.
 */
export const DEFAULT_FLOOR = 100;

/**
 * The smallest spread the denominator is allowed to take, in stars per week.
 *
 * A repository whose baseline weeks are all identical (very common at the
 * quiet end, where they are all zero) has a median absolute deviation of
 * zero, and dividing by that yields Infinity for every one of them, which is
 * not an ordering. One star a week is also the point below which the spread is
 * finer than the data it comes from, since weekly deltas are integers.
 *
 * It has a consequence that `DEFAULT_FLOOR` exists to price and that anyone
 * changing either constant needs to hold in mind: where this pin binds, the
 * score is no longer normalised at all: it is `gained / weeks`, on a different
 * scale from every row that has a real baseline to be divided by.
 */
export const MIN_SPREAD = 1;

/** the middle value of `values`, which must be non-empty; average of two if even */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * How far a typical week sits from the typical week, which is the unit the
 * score is measured in.
 *
 * Median absolute deviation, and left in its own units rather than multiplied
 * by the usual 1.4826 to make it read as a standard deviation. That constant
 * would only rescale every score by the same factor (nobody reads this
 * number) while changing which repositories bump into `MIN_SPREAD`, so it
 * would be a magic number that bought nothing and moved the floor.
 */
function spreadOf(values: number[], centre: number): number {
  return Math.max(
    median(values.map((value) => Math.abs(value - centre))),
    MIN_SPREAD,
  );
}

/**
 * How hard a repository is accelerating against its own past, or null.
 *
 * `weekly` is net stars per week, oldest → newest, as stored in `star_history`;
 * values may be negative, because people unstar things. Sixty entries at the
 * current backfill depth, and the last `opts.weeks` of them are the window
 * being judged; the baseline is everything before that, never including the
 * window itself, or a spike would be measured against a normality it had
 * already inflated.
 *
 * `opts.weeks` is which of the front page's three rubrics is being asked for:
 * 1 for 7d, the default 4 for 30d, 52 for 1y. It buys a wider window and pays
 * for it in baseline (see `minBaselineFor`, which is what makes a 1y ordering
 * a question about the depth of the backfill rather than a free parameter).
 *
 * `opts.floor` is a count of stars over the window, not a rate, so it does not
 * scale itself when the window widens: `DEFAULT_FLOOR` is 25 stars in four
 * weeks and stays 25 stars in fifty-two unless the caller says otherwise. A
 * front page building a 1y block almost certainly wants to pass a larger one
 * (a year to gather 25 stars is the noise the floor exists to exclude), but that
 * is a decision about a rubric, and making the same argument mean different
 * numbers in different calls would hide it.
 *
 * Null means the question could not be answered about this repository: too
 * little history for the window asked for, or a window that did not clear the
 * floor. Null is not zero and does not sort like one: those rows sort last,
 * after even the repositories that are losing stars, which score negative and
 * are meant to. A malformed `weeks` is not that kind of answer and throws
 * instead: it is a mistake in the caller, and returning null would bury it as
 * an empty rubric rather than a stack trace.
 *
 * **A sort key. Never rendered.** See the note at the top of this file.
 */
export function trendScore(
  weekly: number[],
  opts?: { floor?: number; weeks?: number },
): number | null {
  const floor = opts?.floor ?? DEFAULT_FLOOR;
  const weeks = opts?.weeks ?? RECENT_WEEKS;

  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new RangeError(
      `trendScore: weeks must be a positive whole number of weeks, got ${weeks}`,
    );
  }

  if (weekly.length - weeks < minBaselineFor(weeks)) return null;

  const recent = weekly.slice(-weeks);
  const baseline = weekly.slice(0, -weeks);

  // `!(gained >= floor)` rather than `gained < floor` so that a NaN anywhere in
  // the window (a hole in the history, not a number of stars) fails the gate
  // instead of falling through it
  const gained = recent.reduce((sum, week) => sum + week, 0);
  if (!(gained >= floor)) return null;

  const normal = median(baseline);
  const score = (gained / weeks - normal) / spreadOf(baseline, normal);
  if (!Number.isFinite(score)) return null;

  // two decimals: this is a sort key that ships in every row of every shard, and
  // seventeen digits of a quantity nobody reads is JSON nobody should pay for.
  // The precision that remains is still finer than the weekly integers it came
  // from deserve.
  return Math.round(score * 100) / 100;
}
