import { test } from "node:test";
import assert from "node:assert/strict";

import type { ActivityStates } from "./contracts.ts";
import {
  ACTIVE_CEILING_DAYS,
  MIN_COHORT,
  activityStates,
  type ActivityInput,
} from "./activity.ts";

/**
 * These tests are where the design is actually checked, because the label is a
 * judgement about somebody else's project and nothing on the screen reveals it
 * to be wrong: "stalled" under a finished C library looks exactly like
 * "stalled" under an abandoned one.
 *
 * The cohorts below are built from the real shape of `data/awesome.db`,
 * measured 2026-09-12 — days since `pushed_at` at the 0/25/50/75/90/100th
 * percentiles of each language — so that the C-versus-npm case is tested
 * against the distributions that actually exist rather than against two numbers
 * chosen to make the test pass.
 */

const DAY = 86_400;
const NOW = 1_787_000_000; // the crawl this file's figures were measured on

/**
 * Measured quantile curves of days since last push, by language: days at the
 * 0th, 25th, 50th, 75th, 90th and 100th percentile of the cohort.
 */
const QUANTILES = [0, 0.25, 0.5, 0.75, 0.9, 1] as const;
const MEASURED = {
  // n = 814. a quarter of it has been quiet for two and a half years
  C: [0, 39, 165, 928, 2100, 5000],
  // n = 2,995. the quietest quarter starts at eight months
  TypeScript: [0, 30, 69, 239, 633, 2000],
  // n = 587. half of it has not been touched in five years
  "Objective-C": [0, 852, 1921, 3127, 3670, 5000],
} as const;

/**
 * `n` repositories in `language`, their ages read off `curve` at evenly spaced
 * percentiles — so the fixture has the shape the real cohort has, and not the
 * shape six numbers spaced evenly would have.
 *
 * The ids carry the age so that a failing assertion says which repository it
 * was looking at rather than which array index.
 */
function cohort(
  language: string,
  curve: readonly number[],
  n = 40,
): ActivityInput[] {
  return Array.from({ length: n }, (_, i) => {
    const p = i / (n - 1);
    let upper = QUANTILES.findIndex((q) => q >= p);
    if (upper < 1) upper = 1;
    const lower = upper - 1;
    const span = QUANTILES[upper]! - QUANTILES[lower]!;
    const weight = (p - QUANTILES[lower]!) / span;
    const days = curve[lower]! * (1 - weight) + curve[upper]! * weight;
    return repo(`${language}/${Math.round(days)}d`, language, days);
  });
}

function repo(
  id: string,
  language: string | null,
  daysIdle: number | null,
  archived = false,
): ActivityInput {
  return {
    id,
    language,
    lastActivityAt: daysIdle === null ? null : NOW - Math.round(daysIdle * DAY),
    archived,
  };
}

const EIGHTEEN_MONTHS = 548;

test("eighteen months idle is not the same verdict in C as in an npm ecosystem", () => {
  // the entire reason this function takes a population instead of a repository
  const states = activityStates([
    ...cohort("C", MEASURED.C),
    ...cohort("TypeScript", MEASURED.TypeScript),
    repo("library.c", "C", EIGHTEEN_MONTHS),
    repo("package.ts", "TypeScript", EIGHTEEN_MONTHS),
  ]);

  assert.notEqual(
    states.get("library.c"),
    "stalled",
    "a C library idle 18 months is unremarkable among C libraries",
  );
  assert.equal(states.get("library.c"), "slow");
  assert.equal(
    states.get("package.ts"),
    "stalled",
    "a package idle 18 months is in the quietest quarter of its ecosystem",
  );
});

test("a fixed threshold would have to be wrong about one of them", () => {
  // stated as a property rather than a number: there is no day count that puts
  // the C library and the npm package in the same band and is right about both
  const states = activityStates([
    ...cohort("C", MEASURED.C),
    ...cohort("TypeScript", MEASURED.TypeScript),
    repo("library.c", "C", EIGHTEEN_MONTHS),
    repo("package.ts", "TypeScript", EIGHTEEN_MONTHS),
  ]);
  assert.notEqual(states.get("library.c"), states.get("package.ts"));
});

test("an archived repository is archived whatever the dates say", () => {
  const states = activityStates([
    ...cohort("C", MEASURED.C),
    repo("retired/yesterday", "C", 1, true),
    repo("retired/ancient", "C", 4000, true),
    repo("retired/undated", null, null, true),
    repo("retired/tiny-cohort", "Brainfuck", 1, true),
  ]);

  assert.equal(states.get("retired/yesterday"), "archived");
  assert.equal(states.get("retired/ancient"), "archived");
  assert.equal(states.get("retired/undated"), "archived");
  assert.equal(states.get("retired/tiny-cohort"), "archived");
});

test("archived repositories are labelled but do not move the thresholds", () => {
  const living = cohort("C", MEASURED.C);
  const probe = repo("library.c", "C", EIGHTEEN_MONTHS);
  const graveyard = Array.from({ length: 60 }, (_, i) =>
    repo(`dead/${i}`, "C", 3000 + i, true),
  );

  const alone = activityStates([...living, probe]);
  const withDead = activityStates([...living, probe, ...graveyard]);

  for (const row of [...living, probe]) {
    assert.equal(
      withDead.get(row.id),
      alone.get(row.id),
      `${row.id} changed band because sixty dead repositories were in the room`,
    );
  }
});

test("a cohort too small to have a distribution is left unjudged", () => {
  const small = cohort("Befunge", MEASURED.C, MIN_COHORT - 1);
  const enough = cohort("Fortran", MEASURED.C, MIN_COHORT);
  const states = activityStates([...small, ...enough]);

  for (const row of small) {
    assert.equal(
      states.has(row.id),
      false,
      `${row.id} was labelled from a cohort of ${MIN_COHORT - 1}`,
    );
  }
  for (const row of enough) assert.equal(states.has(row.id), true);
});

test("a missing key is an answer: no language, no date, no judgement", () => {
  const states = activityStates([
    ...cohort("C", MEASURED.C),
    repo("data/only", null, 10),
    repo("never/fetched", "C", null),
  ]);

  assert.equal(states.has("data/only"), false);
  assert.equal(states.has("never/fetched"), false);
});

test("empty and single-repository populations do not throw", () => {
  assert.equal(activityStates([]).size, 0);
  assert.equal(activityStates([repo("one/repo", "C", 5)]).size, 0);
  assert.equal(activityStates([repo("one/repo", "C", 5, true)]).size, 1);
});

test("the bands are a quarter, a quarter and a half of the cohort", () => {
  // 100 repositories, one a week apart, all recent enough that the ceiling
  // never fires: the split should be exactly the percentile design
  const weekly = Array.from({ length: 100 }, (_, i) =>
    repo(`go/${i}`, "Go", i * 3),
  );
  const states = activityStates(weekly);
  const count = (state: string) =>
    [...states.values()].filter((value) => value === state).length;

  assert.equal(count("stalled"), 25);
  assert.equal(count("slow"), 25);
  assert.equal(count("active"), 50);
});

test("the oldest of the cohort is stalled and the newest is active", () => {
  const states = activityStates(
    Array.from({ length: 40 }, (_, i) => repo(`rust/${i}`, "Rust", i * 3)),
  );
  assert.equal(states.get("rust/0"), "active");
  assert.equal(states.get("rust/39"), "stalled");
});

test("nothing unpushed for a year is called active, however quiet its peers", () => {
  // half of Objective-C has not been touched in five years; being the liveliest
  // corpse in the cohort is a fact about standing, not a pulse
  const states = activityStates(cohort("Objective-C", MEASURED["Objective-C"]));

  const stale = [...cohort("Objective-C", MEASURED["Objective-C"])].filter(
    (row) => NOW - row.lastActivityAt! > ACTIVE_CEILING_DAYS * DAY,
  );
  assert.ok(
    stale.length > 0,
    "fixture should contain repositories over a year idle",
  );
  for (const row of stale) {
    assert.notEqual(
      states.get(row.id),
      "active",
      `${row.id} has not been pushed in over a year`,
    );
  }
  // and the guard only ever demotes one step: the cohort keeps sole authority
  // over "stalled", which is the label a fixed threshold gets wrong
  const demoted = stale.filter((row) => states.get(row.id) === "slow");
  assert.ok(demoted.length > 0, "expected the ceiling to demote somebody");
});

test("the ceiling measures from the newest push in the dataset, not the clock", () => {
  // a crawl that is six months stale should age consistently rather than
  // quietly demote everything in it
  const shifted = (offsetDays: number) =>
    activityStates(
      Array.from({ length: 40 }, (_, i) =>
        repo(`go/${i}`, "Go", i * 20 + offsetDays),
      ),
    );
  assert.deepEqual([...shifted(0)], [...shifted(180)]);
});

test("the implementation matches the signature declared in contracts.ts", () => {
  // the shard builder is written against the declaration, not against this
  // file, so the two are only kept honest by asking the compiler here
  const contract: ActivityStates = activityStates;
  assert.equal(typeof contract, "function");
});
