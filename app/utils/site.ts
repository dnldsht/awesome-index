/**
 * Where the site lives, for the one thing that needs an absolute URL.
 *
 * A canonical has to be absolute, and with `nuxt generate` there is no request
 * to infer an origin from: the HTML is written on a laptop or in a runner and
 * served from wherever. So it is a constant. DESIGN.md keeps the domain
 * unchanged (`awesome.donld.me`) and says to revisit that before any launch
 * push; this is the single place a revisit would touch.
 */
export const SITE = "https://awesome.donld.me";

/** The canonical URL of a list: the bare path, never a query variant. */
export function listCanonical(slug: string): string {
  return `${SITE}/${slug}`;
}
