/**
 * Turning somebody else's popularity figure into a position in our order.
 *
 * Two thirds of what the lists link is a repository and sorts itself: stars are
 * one scale and every row on it is measured the same way. The rest — 11,491
 * rows — has no star count, and the reason the listings used to drop it below
 * the ranking rather than into it is that its evidence arrives in units that do
 * not compare. Measured on this dataset:
 *
 *   median stars, github.com    427   (n = 34,808)
 *   median stars, gitlab.com     20   (n = 118)
 *   median stars, codeberg.org    5   (n = 82)
 *
 * 200 stars is the 96th percentile of Codeberg and the 37th of GitHub. Sorting
 * the raw numbers together does not merely blur the order, it asserts something
 * false: that every project on a small forge is worse than the median project
 * on a large one. Downloads are worse still, because they are not even a count
 * of people — a crate's `recent_downloads` runs to 224M against a MetaCPAN
 * "++" tally that tops out at 514.
 *
 * So nothing is compared in its own unit. A row's figure buys it a percentile
 * inside its own cohort, and that percentile is looked up in the star
 * distribution of the GitHub repositories *in this dataset*. The result is a
 * star equivalent: not what the thing has, but where it sits.
 *
 * The choice of that last distribution is what makes the mapping defensible
 * rather than arbitrary. Both cohorts have already been filtered the same way —
 * somebody curating an awesome list chose to write them down — so the 90th
 * percentile of one is being matched against the 90th percentile of a
 * comparable population, not against all of GitHub, where almost every listed
 * project is already exceptional.
 */

/** the ways a row can come by a popularity figure, none of them a star count */
export const POPULARITY_SOURCES = [
  /** the link is a project's own site and we found the repository behind it */
  "inherited",
  /** the link is a package page and the registry told us its repository */
  "registryRepo",
  /** the link is a package page and the registry only had a figure of its own */
  "registryNative",
  /** the link is a repository on a forge that is not GitHub */
  "forge",
] as const;

export type PopularitySource = (typeof POPULARITY_SOURCES)[number];

/**
 * The cohort whose percentiles are the scale everything else is mapped onto,
 * i.e. the one population that needs no translating.
 *
 * A measurement in this cohort is already a GitHub star count — it was read off
 * a repository we resolved the link to — so its star equivalent is itself, and
 * `starEquivalents` passes it through untouched rather than round-tripping it
 * through its own distribution and quietly moving it.
 */
export const GITHUB_COHORT = "github";

/**
 * How small a cohort may get before its percentiles stop meaning anything.
 *
 * Four Gitea instances with one repository each do not have a distribution;
 * ranking them against each other would be reading noise as a signal, and the
 * calibrated numbers it produced would be indistinguishable from measured ones
 * once they were in the column. Cohorts under this are reported and left
 * unranked instead — which is the state those rows are in today anyway, so the
 * floor costs nothing and buys the column its meaning.
 */
export const MIN_COHORT = 8;

/** one row's popularity figure, in whatever unit its source happened to use */
export type Measurement = {
  targetId: string;
  source: PopularitySource;
  /** what the figure belongs to: "facebook/react", "crates.io/serde" */
  ref: string;
  /** the figure as measured, in its own unit */
  raw: number;
  /**
   * The population `raw` has to be ranked inside before it means anything:
   * "github" for a real star count, otherwise a name for the scale it is on
   * ("codeberg.org", "crates.io/downloads"). Cohorts are compared internally
   * and never across, so the name only has to separate incomparable units — two
   * registries that both report monthly downloads still get one cohort each,
   * because their audiences differ by orders of magnitude.
   */
  cohort: string;
};

export type Calibration = {
  /** target id to star equivalent, for the rows a cohort was big enough to rank */
  popularity: Map<string, number>;
  /** cohorts left unranked for being under `MIN_COHORT`, and how many rows each cost */
  dropped: { cohort: string; rows: number }[];
};

/**
 * Where `value` sits in `sorted`, as a fraction between 0 and 1.
 *
 * Midrank, not "fraction below": with plain `<` the smallest value in a cohort
 * scores 0 and maps to the least starred repository in the dataset, which for a
 * cohort of eight is a claim about the bottom of GitHub that eight rows cannot
 * support. Ties share their midpoint, which matters more than it sounds —
 * MetaCPAN reports 42 of its 297 distributions with zero "++", and they have to
 * come out equal rather than in whatever order the array happened to hold them.
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
 * The value at `fraction` through `sorted`, interpolating between neighbours.
 *
 * Linear rather than nearest-rank because the star distribution is long-tailed
 * and sparse at the top: nearest-rank would snap a whole band of percentiles
 * onto the same handful of huge repositories, and hand several unrelated rows
 * an identical star equivalent for no reason other than that 200,000-star
 * repositories are rare.
 */
function quantileOf(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const at = fraction * (sorted.length - 1);
  const lower = Math.floor(at);
  const upper = Math.ceil(at);
  if (lower === upper) return sorted[lower]!;
  const weight = at - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/**
 * Star equivalents for a batch of measurements.
 *
 * `starDistribution` is every star count in the dataset that a repository
 * actually has — unsorted is fine, it is copied and sorted here. Pass it once
 * for the whole batch: it is the scale, so calibrating two halves of a run
 * against two different snapshots of it would make the halves disagree.
 */
export function starEquivalents(
  measurements: Measurement[],
  starDistribution: number[],
): Calibration {
  const stars = [...starDistribution].sort((a, b) => a - b);
  const popularity = new Map<string, number>();
  const dropped: { cohort: string; rows: number }[] = [];

  const byCohort = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const cohort = byCohort.get(measurement.cohort) ?? [];
    cohort.push(measurement);
    byCohort.set(measurement.cohort, cohort);
  }

  for (const [cohort, rows] of byCohort) {
    // already stars, and already on the scale: translating would only add error
    if (cohort === GITHUB_COHORT) {
      for (const row of rows) popularity.set(row.targetId, Math.round(row.raw));
      continue;
    }
    if (rows.length < MIN_COHORT) {
      dropped.push({ cohort, rows: rows.length });
      continue;
    }
    const sorted = rows.map((row) => row.raw).sort((a, b) => a - b);
    for (const row of rows) {
      const fraction = percentileOf(sorted, row.raw);
      popularity.set(row.targetId, Math.round(quantileOf(stars, fraction)));
    }
  }

  return { popularity, dropped: dropped.sort((a, b) => b.rows - a.rows) };
}

/** the shapes a borrowed figure can take on a card, which decides its icon */
export type RawShape = "stars" | "downloads" | "likes";

/**
 * What a borrowed figure counts, and where it was counted.
 *
 * A row that carries somebody else's number has to say whose and of what, or it
 * is the thing this whole file exists to avoid: "1.6M" next to a package,
 * indistinguishable from a star count and forty times the largest one in the
 * dataset. `shape` picks the icon, `label` is the sentence a reader gets on hover.
 */
export function describeRaw(
  source: PopularitySource,
  cohort: string,
  ref: string,
  raw: number,
): { shape: RawShape; label: string } {
  const count = raw.toLocaleString("en-US");
  const [, metric] = cohort.split(":");

  if (source === "inherited" || source === "registryRepo") {
    return { shape: "stars", label: `${count} stars on ${ref}` };
  }
  if (source === "forge") {
    // the cohort is the host for a forge big enough to have its own, and the
    // pooled name for the rest, where the ref is the only place the host survives
    const host = cohort.includes(":") ? ref.split("/")[0] : cohort;
    return { shape: "stars", label: `${count} stars on ${host}` };
  }

  const registry = cohort.split(":")[0] ?? "";
  switch (metric) {
    case "monthlyDownloads":
      return {
        shape: "downloads",
        label: `${count} downloads a month on ${registry}`,
      };
    case "recentDownloads":
      return {
        shape: "downloads",
        label: `${count} recent downloads on ${registry}`,
      };
    case "favourites":
      return { shape: "likes", label: `${count} favourites on ${registry}` };
    case "likes":
      return { shape: "likes", label: `${count} likes on ${registry}` };
    default:
      return { shape: "likes", label: `${count} on ${registry}` };
  }
}

/**
 * "git+https://github.com/serde-rs/serde.git" -> "https://github.com/serde-rs/serde".
 *
 * Registry metadata is written by hand into a manifest and reaches us in every
 * spelling a `git remote` accepts: `git://`, `git+https://`, `ssh://git@`, with
 * and without `.git`, occasionally with a `#branch` on the end. `normalizeRepoId`
 * only reads http(s) URLs, correctly — it exists to tell repository links apart
 * from badges on a README, not to guess at transports — so the guessing happens
 * here, where the input is known to be somebody's declared source of truth.
 *
 * Returns undefined rather than a URL when there is nothing to clean up, so a
 * caller can tell "no repository declared" from "declared, unparseable".
 */
export function repoUrlFromManifest(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const normalized = trimmed
    .replace(/^git\+/, "")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^git:\/\//, "https://")
    .replace(/#.*$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  return /^https?:\/\//.test(normalized) ? normalized : undefined;
}
