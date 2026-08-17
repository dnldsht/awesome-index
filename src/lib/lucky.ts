import { loadConfig } from "./config.ts";
import { categoriesForList, UNCATEGORIZED_SLUG } from "./queries.ts";
import { categoryPath } from "./urls.ts";

/**
 * Two exclusions, both about not wasting the click:
 *
 * - fewer than MIN_PROJECTS entries, which drops 2,179 of the 3,263 categories.
 *   The long tail is headings like "Fuzzing" with one crate under them, and a
 *   random jump that lands on a page holding a single row reads as broken
 *   rather than as lucky.
 * - the synthetic uncategorized bucket, which is not a heading anyone wrote and
 *   is a bag of leftovers on the lists that have one.
 */
const MIN_PROJECTS = 8;

let cache: string[] | undefined;

/**
 * Every category page worth landing on, which is what the home page's
 * "I'm feeling lucky" draws from.
 *
 * Memoised for the same reason as `listSummaries()`: it costs one query per
 * list, and both the home page and `/lucky.json` want the whole pool in the
 * same build.
 */
export async function luckyPaths(): Promise<string[]> {
  if (cache) return cache;
  const entries = await loadConfig();
  const paths: string[] = [];

  for (const entry of entries) {
    for (const category of await categoriesForList(entry)) {
      if (category.count < MIN_PROJECTS) continue;
      if (category.slug === UNCATEGORIZED_SLUG) continue;
      paths.push(categoryPath(entry.slug, category.slug));
    }
  }

  cache = paths;
  return cache;
}

/**
 * The one the button points at before any script runs.
 *
 * Drawn at build time, so it is the same page for everyone until the next
 * nightly build and different after it. That is the whole behaviour without
 * JavaScript, and the floor under the version with it: the fetch can fail, the
 * file can 404, and the click still lands somewhere real.
 */
export async function luckyFallback(): Promise<string> {
  const paths = await luckyPaths();
  return paths[Math.floor(Math.random() * paths.length)] ?? "/";
}
