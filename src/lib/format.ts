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

/** 58210 -> "58.2k", so counts stay one glanceable token wide */
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
