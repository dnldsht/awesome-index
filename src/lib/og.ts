/**
 * Where the build-time OG images live.
 *
 * Kept apart from the renderer on purpose: this module is imported by pages,
 * and pulling `satori` + `@resvg/resvg-js` into every page module would drag a
 * native addon and a wasm layout engine into ~20k route renders that never
 * rasterise anything.
 *
 * There is deliberately no per-repository image. One list is a handful of
 * rasterisations; one repository is tens of thousands, which would cost more
 * build time than the rest of the site put together for a picture almost
 * nobody would ever see.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** the fallback card, used by every route that has no image of its own */
export const OG_DEFAULT_PATH = "/og-default.png";

/**
 * The card for one list, rendered by `src/pages/og/[list].png.ts`.
 *
 * A list page opts into it by passing the result to `Base`:
 *
 *     <Base ... ogImage={ogListPath(entry.slug)}>
 *
 * `slug` must come from a `ConfigEntry`, i.e. from `listSummaries()`, so the
 * path can only ever name an image the build actually emitted.
 */
export const ogListPath = (slug: string) => `/og/${slug}.png`;
