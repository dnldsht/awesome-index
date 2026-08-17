/**
 * The dataset's one advantage over the README it was built from is that it
 * knows whether a project is still moving. These helpers turn `pushedAt` into
 * the vocabulary the UI is built on.
 */

export type Liveness = "active" | "steady" | "slowing" | "dormant";

const DAY = 24 * 60 * 60 * 1000;

/** buckets chosen so that a healthy library sits in "active" or "steady" */
export function liveness(pushedAt: Date, now = Date.now()): Liveness {
  const days = (now - pushedAt.getTime()) / DAY;
  if (days <= 90) return "active";
  if (days <= 365) return "steady";
  if (days <= 365 * 3) return "slowing";
  return "dormant";
}

export const LIVENESS_LABEL: Record<Liveness, string> = {
  active: "active",
  steady: "steady",
  slowing: "slowing",
  dormant: "dormant",
};

/** the scale in order, freshest first; the order every legend is stacked in */
export const LIVENESS_ORDER: Liveness[] = [
  "active",
  "steady",
  "slowing",
  "dormant",
];

export type PulseBreakdown = {
  counts: Record<Liveness, number>;
  /** the same buckets as a share of the whole, summing to exactly 100 */
  percentages: Record<Liveness, number>;
  total: number;
};

/**
 * How a set of repositories is spread across the pulse scale.
 *
 * Percentages are rounded by largest remainder rather than independently: four
 * numbers each rounded on their own routinely add up to 99 or 101, and a header
 * whose whole point is "here is the state of this list" cannot show a total
 * that is not a total.
 */
export function pulseBreakdown(
  repos: { pushedAt: Date }[],
  now = Date.now(),
): PulseBreakdown {
  const counts: Record<Liveness, number> = {
    active: 0,
    steady: 0,
    slowing: 0,
    dormant: 0,
  };
  for (const repo of repos) counts[liveness(repo.pushedAt, now)]++;

  const total = repos.length;
  const percentages: Record<Liveness, number> = {
    active: 0,
    steady: 0,
    slowing: 0,
    dormant: 0,
  };
  if (total === 0) return { counts, percentages, total };

  const exact = LIVENESS_ORDER.map((key) => (counts[key] / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((sum, n) => sum + n, 0);

  // hand the leftover points to the buckets that lost the most to flooring
  const order = exact
    .map((value, index) => ({ index, remainder: value - floors[index]! }))
    .sort((a, b) => b.remainder - a.remainder);

  for (const { index } of order) {
    if (left <= 0) break;
    floors[index]!++;
    left--;
  }

  LIVENESS_ORDER.forEach((key, index) => {
    percentages[key] = floors[index]!;
  });

  return { counts, percentages, total };
}

/** 58210 -> "58.2K", so counts stay one glanceable token wide */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function fullNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

/** "3 days ago", "2 years ago" */
export function relativeTime(date: Date, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diff = date.getTime() - now;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * DAY],
    ["month", 30 * DAY],
    ["week", 7 * DAY],
    ["day", DAY],
    ["hour", 60 * 60 * 1000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

/** machine readable, for <time datetime> and sitemap lastmod */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
