/**
 * Every internal link goes through here. The site is built with
 * `trailingSlash: "always"`, so a path that forgets its slash costs a redirect
 * on GitHub Pages, and a canonical that disagrees with the sitemap costs worse.
 */

export const listPath = (slug: string) => `/${slug}/`;

export function categoryPath(slug: string, sectionSlug: string): string {
  // 1123 awesome_item rows sit above any heading and carry an empty
  // sectionSlug. Building a URL from one here would emit "/javascript//" — a
  // path that 404s and that the sitemap would happily list. They are not
  // orphaned any more: `categoriesForList()` files them under a synthetic
  // heading whose slug is UNCATEGORIZED_SLUG, and every caller should be
  // holding that slug rather than the raw "" by the time it gets here.
  if (!sectionSlug) {
    throw new Error(
      `categoryPath("${slug}", "") — entries with no heading carry an empty ` +
        `section slug; map them through queries.ts' sectionOf() first`,
    );
  }
  return `/${slug}/${sectionSlug}/`;
}

/**
 * The segment paginated URLs hang off: `/golang/page/2/`,
 * `/golang/web-frameworks/page/2/`.
 *
 * Page 1 never uses it, so `/golang/` and `/golang/web-frameworks/` keep the
 * URLs they have always had and nothing already indexed moves.
 */
export const PAGE_SEGMENT = "page";

const PAGINATED = new RegExp(`(?:^|/)${PAGE_SEGMENT}/[0-9]+$`);

/**
 * True when a heading path would render as a URL this scheme already owns.
 *
 * `/[list]/[...category]` swallows arbitrary depth, so a README with headings
 * "Page" › "2" would produce `/golang/page/2/` from the category route as well
 * as from the pagination one. No section slug in the dataset does — all 423
 * were checked, and none contains a `page` segment at any depth — but the
 * crawler re-reads those READMEs every night, so `categoriesForList()` asserts
 * this on every build rather than trusting a snapshot.
 */
export const collidesWithPagination = (sectionSlug: string) =>
  PAGINATED.test(sectionSlug);

/** page 1 stays at `base`; only page 2 and beyond grow a suffix */
export function paginated(base: string, page: number): string {
  return page <= 1 ? base : `${base}${PAGE_SEGMENT}/${page}/`;
}

export const listPagePath = (slug: string, page: number) =>
  paginated(listPath(slug), page);

export const categoryPagePath = (
  slug: string,
  sectionSlug: string,
  page: number,
) => paginated(categoryPath(slug, sectionSlug), page);

export const repoPath = (repoId: string) => `/r/${repoId}/`;

/** the repository on github.com, not on this site */
export const githubUrl = (repoId: string) => `https://github.com/${repoId}`;

export const ownerUrl = (login: string) => `https://github.com/${login}`;

/** absolute, for canonical tags, og:url and the sitemap */
export function absolute(path: string): string {
  return new URL(path, import.meta.env.SITE).href;
}
