/**
 * Saying whether a project is still moving, without saying that C is dead.
 *
 * The trap, and it is the whole reason this file is not four `if` statements
 * over a number of days: **dead is not the same as finished**. Eighteen months
 * without a commit is abandonment for an npm package and an unremarkable year
 * for a C library that does one thing and has done it since 2014. A fixed
 * threshold does not get this slightly wrong for a few repositories; it gets it
 * systematically wrong for entire families of languages at once, and it gets it
 * wrong in the direction that is hardest to forgive — telling a reader that
 * finished work is abandoned.
 *
 * Measured on this dataset (34,808 repositories, days since `pushed_at`, taken
 * 2026-09-12), the spread between ecosystems is not a nuance:
 *
 *                   median   oldest quartile begins at
 *   TypeScript        69 d          239 d
 *   Rust              46 d          297 d
 *   C                165 d          928 d
 *   JavaScript       760 d        1,670 d
 *   Objective-C    1,921 d        3,127 d
 *
 * One number cannot serve that table. So the thresholds are **percentiles
 * inside the repository's own language cohort**, recomputed from the population
 * handed in — which is the mechanism `popularity.ts` already defends for star
 * counts across forges, applied to a problem with the same shape: rank a value
 * inside the only population it is comparable with, rather than compare
 * incomparable units. "Stalled" means in the bottom quartile of activity
 * *among projects in this language in this dataset*, and nobody has to believe
 * a constant somebody picked.
 *
 * Two consequences worth stating, since both look like bugs from outside:
 *
 * - No clock is read. Percentiles over timestamps rank identically to
 *   percentiles over ages, so the ordering needs no "now" at all, and the one
 *   place a duration is genuinely needed (`ACTIVE_CEILING_DAYS`) measures from
 *   the newest push in the population rather than from the wall clock. A
 *   dataset that is a month stale then ages consistently instead of quietly
 *   demoting every repository in it, and the function is deterministic, which
 *   is why it can be tested at all.
 * - Archived repositories are labelled but do not vote. They are dead by
 *   declaration, and leaving them in the sample would drag every cohort's
 *   thresholds toward staleness — the more of a language's projects have been
 *   retired, the easier it would become for the survivors to look active.
 *
 * The weak link is `pushed_at` itself, and `DESIGN.md` records it as such: it
 * cannot tell a README typo from forty commits by six people, and a dependabot
 * run moves it unaided. The cohort percentile absorbs a good deal of that —
 * whatever inflates one repository's `pushed_at` inflates its neighbours' — but
 * not all of it. If the "stalled" label ever causes an argument, that is where
 * to look first, not here.
 */

import type { ActivityState } from "./contracts.ts";

/**
 * How small a language cohort may get before its percentiles stop meaning
 * anything.
 *
 * Stricter than `popularity.ts`'s eight, and deliberately so, because the two
 * numbers are asked for different things. There, a small cohort buys a row a
 * percentile which is then looked up in a distribution of 34,808 star counts,
 * so the coarseness costs precision and nothing else. Here the cohort *is* the
 * answer: the boundary between "slow" and "stalled" is computed from those rows
 * and no others, and in a cohort of eight it is a single repository's push
 * date. Twenty puts five repositories in the bottom quartile, which is few but
 * is no longer one person's Tuesday.
 *
 * Measured cost of the choice: 44 of 146 languages keep their labels, and the
 * 349 repositories in the other 102 (1.1% of the corpus) go unlabelled rather
 * than judged on noise — which is the state every row is in today anyway.
 */
export const MIN_COHORT = 20;

/**
 * The longest a repository may go unpushed and still be called "active",
 * whatever its cohort thinks.
 *
 * This is the one absolute number in the file and it is not a judgement about
 * abandonment — the cohort keeps sole authority over that. It is about what the
 * word means. "Active" is a claim in the present tense, and a purely relative
 * scale will happily make it about a repository that has not been touched in
 * five years, because half of Objective-C has not been touched in five years.
 * Being the liveliest corpse in the cohort is a real fact about a project's
 * standing among its peers and it is not a pulse.
 *
 * So the guard is one-directional: it can only demote "active" to "slow". It
 * can never produce "stalled", because that is exactly the label the fixed
 * threshold gets wrong about finished C libraries, and the cohort is the only
 * thing allowed to say it. On this dataset the guard moves 1,462 repositories
 * (9% of everything the percentiles would have called active) down one step;
 * 682 of them had not been pushed in over two years.
 */
export const ACTIVE_CEILING_DAYS = 365;

/**
 * A repository, and only a repository.
 *
 * `archived` is a required boolean and that is load-bearing. In the database
 * the column is `integer | null` and it is **null for all 11,491 `web`
 * targets** — a website cannot be archived, so there is nothing to know — which
 * means a caller who hands this function a mixed population cannot get past the
 * compiler without stopping to decide what a null means. Deciding it means
 * `false` is how a website becomes a project with a pulse.
 *
 * Should one be coerced in anyway, it still cannot acquire a label: a `web`
 * target has no language and no `last_activity_at`, so it has no cohort to be
 * ranked in and falls out of the map entirely.
 */
export type ActivityInput = {
  id: string;
  /** GitHub's `primary_language`, as GitHub spells it */
  language: string | null;
  /** `pushed_at`, unix seconds */
  lastActivityAt: number | null;
  archived: boolean;
};

/**
 * Where `value` sits in `sorted`, as a fraction between 0 and 1.
 *
 * Midrank, exactly as in `popularity.ts`: the smallest member of a cohort
 * scores its own half-share rather than a flat zero, and ties share their
 * midpoint. Push timestamps tie rarely, but when they do — two repositories
 * pushed in the same second by the same bot — they must come out equal rather
 * than in whatever order the array happened to hold them, because one of those
 * orders would put one of them in a different quartile from the other.
 */
function percentileOf(sorted: number[], value: number): number {
  let below = 0;
  let equal = 0;
  for (const entry of sorted) {
    if (entry < value) below++;
    else if (entry === value) equal++;
  }
  return (below + equal / 2) / sorted.length;
}

/**
 * The activity label for each repository, keyed by id.
 *
 * Takes the whole population rather than one repository at a time because the
 * thresholds come from it. Three bands, from one settled cut and one obvious
 * one: the bottom quartile of its language is **stalled** (`DESIGN.md`), the
 * rest of the bottom half is **slow**, and the top half is **active** unless
 * `ACTIVE_CEILING_DAYS` says the word would be a lie. `archived: true`
 * short-circuits to **archived** whatever the dates say — it is the one state
 * the author declared rather than the one we inferred, which is also why it is
 * the only one stated plainly.
 *
 * A missing key is a real answer and means "we do not know": the repository's
 * language cohort was under `MIN_COHORT`, or it has no language, or it has no
 * push date. `Row`'s `state` is null for those, and the row still shows the
 * date, which is the fact the label was only ever an interpretation of.
 *
 * A repository with no language at all — 1,016 of them, mostly data and
 * documentation repositories — is left unlabelled rather than pooled into a
 * cohort of its own. Pooling them would be the one thing this file exists to
 * refuse: "has no detectable language" describes how GitHub read a file tree,
 * not a shared release culture, and a dataset repository updated annually is
 * not evidence about a curated link list or a fonts repository.
 */
export function activityStates(
  repos: ActivityInput[],
): Map<string, ActivityState> {
  const states = new Map<string, ActivityState>();

  // archived rows are labelled here and excluded from every cohort below: dead
  // by declaration is not evidence about how fast the living move
  const cohorts = new Map<string, ActivityInput[]>();
  let newestPush = -Infinity;
  for (const repo of repos) {
    if (repo.archived) {
      states.set(repo.id, "archived");
      continue;
    }
    if (repo.language === null || repo.lastActivityAt === null) continue;
    const cohort = cohorts.get(repo.language) ?? [];
    cohort.push(repo);
    cohorts.set(repo.language, cohort);
    if (repo.lastActivityAt > newestPush) newestPush = repo.lastActivityAt;
  }

  const ceiling = newestPush - ACTIVE_CEILING_DAYS * 86400;

  for (const rows of cohorts.values()) {
    if (rows.length < MIN_COHORT) continue;
    const pushes = rows.map((row) => row.lastActivityAt!).sort((a, b) => a - b);

    for (const row of rows) {
      const pushedAt = row.lastActivityAt!;
      const rank = percentileOf(pushes, pushedAt);
      if (rank < 0.25) states.set(row.id, "stalled");
      else if (rank < 0.5) states.set(row.id, "slow");
      else states.set(row.id, pushedAt < ceiling ? "slow" : "active");
    }
  }

  return states;
}
