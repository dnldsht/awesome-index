import { z } from "astro/zod";
import * as fs from "node:fs/promises";
import YAML from "yaml";
import { slugify } from "./slug.ts";

export const GITHUB_PREFIX = "https://github.com/";

/**
 * The two orders a listing can be in.
 *
 * `popularity` ranks by stars, and by the star equivalent of whatever else a row
 * could be measured by (see src/lib/popularity.ts). `editorial` keeps the order
 * the README writes, which is a real answer and not a fallback: a list whose
 * entries are products with their own websites, or tutorials and books, has
 * nothing to be ranked by, and ordering it by the quarter of its rows that
 * happen to live on GitHub would put the other three quarters at the bottom and
 * call that a ranking.
 *
 * Chosen per list rather than globally, because the lists genuinely differ —
 * awesome-perl is 296 CPAN distributions and ranks cleanly, awesome-mac is 588
 * commercial applications and never will.
 */
export const LIST_ORDERS = ["popularity", "editorial"] as const;

export type ListOrder = (typeof LIST_ORDERS)[number];

/**
 * How a list's order is described to a reader, mid-sentence.
 *
 * Defined once because five places state it — the page title, the meta
 * description, the heading above the rows, and the same three on category pages
 * — and a page whose heading and description disagree about what it is sorted by
 * is worse than either wording alone.
 */
export function orderedBy(sort: ListOrder): string {
  return sort === "editorial"
    ? "in the order their curators wrote them"
    : "most starred first";
}

const ConfigSchema = z.object({
  repos: z.array(
    z.object({
      name: z.string(),
      /** one list, or several merged into a single page */
      url: z
        .union([z.string(), z.array(z.string())])
        .transform((u) => (Array.isArray(u) ? u : [u])),
      icon: z.string().optional(),
      /** other entries to surface first in the "more lists" rail */
      related: z.array(z.string()).default([]),
      /**
       * How this list's pages are ordered. Absent means `popularity`, which is
       * what most lists want; the entries that say `editorial` say why.
       */
      sort: z.enum(LIST_ORDERS).default("popularity"),
    }),
  ),
});

export type ConfigEntry = ReturnType<typeof toEntry>;

function toEntry(raw: z.infer<typeof ConfigSchema>["repos"][number]) {
  return {
    ...raw,
    slug: slugify(raw.name),
    /** "<owner>/<repo>" for every source list behind this entry */
    sourceIds: raw.url.map((url) => {
      if (!url.startsWith(GITHUB_PREFIX)) {
        throw new Error(`config.yaml: ${raw.name} has a non-github url ${url}`);
      }
      return url.slice(GITHUB_PREFIX.length).replace(/\/+$/, "");
    }),
  };
}

let cached: ConfigEntry[] | undefined;

export async function loadConfig(): Promise<ConfigEntry[]> {
  if (cached) return cached;
  const parsed = ConfigSchema.parse(
    YAML.parse(await fs.readFile("config.yaml", "utf8")),
  );
  const entries = parsed.repos.map(toEntry);

  const bySlug = new Set<string>();
  for (const entry of entries) {
    if (bySlug.has(entry.slug)) {
      throw new Error(`config.yaml: duplicate slug "${entry.slug}"`);
    }
    bySlug.add(entry.slug);
  }

  cached = entries;
  return entries;
}

export async function findEntry(slug: string) {
  return (await loadConfig()).find((x) => x.slug === slug);
}
