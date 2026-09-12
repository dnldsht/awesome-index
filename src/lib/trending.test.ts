import { test } from "node:test";
import assert from "node:assert/strict";

import type { TrendScore } from "./contracts.ts";
import {
  DEFAULT_FLOOR,
  MIN_BASELINE_WEEKS,
  RECENT_WEEKS,
  minBaselineFor,
  trendScore,
} from "./trending.ts";

/**
 * The tests are the only place this function is checked, because its output
 * never reaches a screen: a wrong trend score does not look wrong, it just
 * quietly puts the wrong project at the top of the front page. So they are
 * written as the claims `DESIGN.md` makes, one test per claim.
 */

/** `weeks` weeks of `perWeek`, with a deterministic wobble of ±`jitter` */
function steady(weeks: number, perWeek: number, jitter = 0): number[] {
  // a tiny LCG rather than Math.random: a flaky ranking test is worse than no
  // ranking test, and "it passed on my machine" is not a property of a sort key
  let seed = 12345;
  return Array.from({ length: weeks }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const offset = jitter === 0 ? 0 : (seed % (2 * jitter + 1)) - jitter;
    return Math.max(0, perWeek + offset);
  });
}

/** a history of `weeks` weeks that runs at `normal` and then jumps to `spike` */
function spikes(weeks: number, normal: number, spike: number): number[] {
  return [
    ...steady(weeks - RECENT_WEEKS, normal, Math.min(normal, 2)),
    ...Array(RECENT_WEEKS).fill(spike),
  ];
}

test("a repository doing what it always does does not trend", () => {
  // React: 400 a week standing still, for over a year
  const score = trendScore(steady(60, 400, 40));
  assert.notEqual(score, null);
  assert.ok(
    Math.abs(score!) < 1,
    `steady history should score near zero, got ${score}`,
  );
});

test("a repository gaining forty where it normally gains three trends hard", () => {
  const score = trendScore(spikes(60, 3, 40));
  assert.notEqual(score, null);
  assert.ok(score! > 10, `a 13x week should score high, got ${score}`);
});

test("the small accelerator outranks the large steady repository", () => {
  // the whole point of the file: "trending" must not collapse into "big"
  const accelerating = trendScore(spikes(60, 3, 40))!;
  const huge = trendScore(steady(60, 400, 40))!;
  assert.ok(
    accelerating > huge,
    `+37 a week over baseline (${accelerating}) should outrank +400 a week standing still (${huge})`,
  );
});

test("a tiny repository cannot trend through the floor", () => {
  // three stars to nine is +200% and is nothing at all
  const history = [...Array(56).fill(0), 0, 3, 3, 3];
  assert.equal(trendScore(history), null);
  // and it is the floor doing it, not the history being unreadable
  assert.notEqual(trendScore(history, { floor: 5 }), null);
});

test("the floor is a count of stars over the recent window, and is caller-settable", () => {
  const justUnder = [
    ...Array(56).fill(0),
    ...Array(RECENT_WEEKS).fill((DEFAULT_FLOOR - 1) / RECENT_WEEKS),
  ];
  const justOver = [
    ...Array(56).fill(0),
    ...Array(RECENT_WEEKS).fill(DEFAULT_FLOOR / RECENT_WEEKS),
  ];
  assert.equal(trendScore(justUnder), null);
  assert.notEqual(trendScore(justOver), null);
  assert.equal(trendScore(justOver, { floor: DEFAULT_FLOOR + 1 }), null);
  assert.notEqual(trendScore(justUnder, { floor: 0 }), null);
});

test("too little history is null, not zero", () => {
  const enough = MIN_BASELINE_WEEKS + RECENT_WEEKS;
  assert.equal(trendScore(Array(enough - 1).fill(50)), null);
  assert.notEqual(trendScore(Array(enough).fill(50)), null);
});

test("empty and single-element histories do not throw", () => {
  assert.equal(trendScore([]), null);
  assert.equal(trendScore([0]), null);
  assert.equal(trendScore([9999]), null);
  assert.equal(trendScore([], { floor: 0 }), null);
});

test("a flat baseline does not divide by zero", () => {
  // every week identical: the MAD is zero and the spread floor is what saves it
  const score = trendScore([...Array(56).fill(0), 30, 30, 30, 30]);
  assert.ok(Number.isFinite(score!), `expected a finite score, got ${score}`);
  assert.equal(score, 30);
});

test("a decelerating repository scores negative rather than null", () => {
  // null means "no answer"; losing momentum is an answer, and it sorts below
  // the repositories that are gaining but above the ones we cannot judge
  const score = trendScore([...steady(56, 400, 20), 60, 60, 60, 60]);
  assert.notEqual(score, null);
  assert.ok(score! < 0, `expected a negative score, got ${score}`);
});

test("losing stars is below the floor", () => {
  assert.equal(trendScore([...steady(56, 10), -5, -5, -5, -5]), null);
});

test("a hole in the history is not a number of stars", () => {
  assert.equal(trendScore([...Array(56).fill(1), NaN, 40, 40, 40]), null);
});

test("a sustained spike outranks a single loud week", () => {
  // the window is four weeks, so one week at sixty is a quarter of the signal
  // of four weeks at sixty — which is the smoothing the 30d default is for
  const four = trendScore(spikes(60, 5, 60))!;
  const one = trendScore([...steady(56, 5, 2), 5, 5, 5, 60])!;
  assert.ok(
    four > one,
    `four spiking weeks (${four}) should outrank one (${one})`,
  );
});

test("bigger accelerations score higher, all else equal", () => {
  const scores = [10, 20, 40, 80].map((spike) =>
    trendScore(spikes(60, 3, spike))!,
  );
  for (let i = 1; i < scores.length; i++) {
    assert.ok(
      scores[i]! > scores[i - 1]!,
      `expected monotonic scores, got ${scores.join(", ")}`,
    );
  }
});

test("the score is rounded to two decimals, because it ships in every row", () => {
  const score = trendScore(spikes(60, 7, 33))!;
  assert.equal(score, Math.round(score * 100) / 100);
});

test("the same history answers three different questions for three windows", () => {
  // `FrontPage.climbing` asks for 7d, 30d and 1y over one series, and the three
  // orderings have to be three orderings — a window that is accepted and then
  // ignored is the silent-wrong-answer version of this whole file
  const history = [
    ...Array(60).fill(2), // a quiet year and a bit
    ...Array(51).fill(9), // a year of steady, higher growth
    100, // and one very loud week
  ];
  const week = trendScore(history, { weeks: 1 })!;
  const month = trendScore(history, { weeks: 4 })!;
  const year = trendScore(history, { weeks: 52 })!;

  assert.equal(
    new Set([week, month, year]).size,
    3,
    `${week} ${month} ${year}`,
  );
  // the loud week dominates the narrow window and is diluted by the wide one
  assert.ok(week > month && month > year, `${week} ${month} ${year}`);
});

test("the default window is unchanged by the parameter existing", () => {
  const history = spikes(60, 3, 40);
  assert.equal(
    trendScore(history),
    trendScore(history, { weeks: RECENT_WEEKS }),
  );
  // pinned, so that a change to the default window has to be a decision
  assert.equal(trendScore(history), 36);
});

test("a window wider than the history returns null", () => {
  // at the two-page backfill depth every repository holds exactly 60 weeks, and
  // 52 of them needs 26 weeks of baseline behind it: 78 in all
  const sixtyWeeks = Array(60).fill(5);
  assert.equal(sixtyWeeks.length, 60);
  assert.equal(trendScore(sixtyWeeks, { weeks: 52 }), null);
  assert.notEqual(trendScore(Array(78).fill(5), { weeks: 52 }), null);
});

test("a wide window is declined on a thin baseline, not answered badly", () => {
  // the boundary the absolute minimum alone would have let through: 52 weeks
  // measured against the 8 weeks that happened to precede them
  const needed = minBaselineFor(52);
  assert.equal(needed, 26);
  assert.equal(trendScore(Array(52 + needed - 1).fill(5), { weeks: 52 }), null);
  assert.notEqual(trendScore(Array(52 + needed).fill(5), { weeks: 52 }), null);
  // and the narrow windows are unaffected: they never needed the ratio
  assert.equal(minBaselineFor(1), MIN_BASELINE_WEEKS);
  assert.equal(minBaselineFor(RECENT_WEEKS), MIN_BASELINE_WEEKS);
});

test("a window that is not a positive whole number of weeks throws", () => {
  // a bad `weeks` is a mistake in the caller, and null would bury it as an
  // empty rubric on the front page instead of as a stack trace in the build
  const history = Array(60).fill(5);
  for (const weeks of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => trendScore(history, { weeks }),
      RangeError,
      `weeks: ${weeks} should have thrown`,
    );
  }
});

test("the floor is counted over whatever window was asked for", () => {
  // 25 stars is a month's floor and stays a year's floor unless the caller says
  // otherwise: the argument means one thing, and the rubric decides its size
  const year = [...Array(26).fill(0), ...Array(52).fill(0.5)];
  assert.notEqual(trendScore(year, { weeks: 52 }), null);
  assert.equal(trendScore(year, { weeks: 52, floor: 27 }), null);
});

test("the implementation matches the signature declared in contracts.ts", () => {
  // the shard builder is written against the declaration, not against this
  // file, so the two are only kept honest by asking the compiler here
  const contract: TrendScore = trendScore;
  assert.equal(typeof contract, "function");
});
