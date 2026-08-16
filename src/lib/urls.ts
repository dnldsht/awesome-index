/**
 * Every internal link goes through here. The site is built with
 * `trailingSlash: "always"`, so a path that forgets its slash costs a redirect
 * on GitHub Pages, and a canonical that disagrees with the sitemap costs worse.
 */

export const listPath = (slug: string) => `/${slug}/`;

export const categoryPath = (slug: string, sectionSlug: string) =>
  `/${slug}/${sectionSlug}/`;

export const repoPath = (repoId: string) => `/r/${repoId}/`;

/** the repository on github.com, not on this site */
export const githubUrl = (repoId: string) => `https://github.com/${repoId}`;

export const ownerUrl = (login: string) => `https://github.com/${login}`;

/** absolute, for canonical tags, og:url and the sitemap */
export function absolute(path: string): string {
  return new URL(path, import.meta.env.SITE).href;
}
