/**
 * How a long listing is cut into pages.
 *
 * Shared by the routes that render the pages and by `sitemap.ts`, which has to
 * name every one of them: if the two ever disagreed on how many pages a
 * listing has, the sitemap would advertise a 404 or hide a real page, and both
 * failures are silent.
 */

/**
 * Rows per page.
 *
 * Measured, not guessed. A rendered `RepoCard` row costs ~1.0KB of HTML — the
 * golang list page was 1,111,530 bytes heavier than the rust one for 1,089
 * more rows — and the frame around a listing (shell, category nav, JSON-LD) is
 * a fixed ~45KB on the widest list, almost all of it the 129-entry nav.
 *
 * That puts a 60-row page at ~105KB raw, comfortably inside the 150KB budget
 * with room for the nav to grow as more lists are crawled. 100 rows would put
 * golang back at ~147KB, i.e. at the limit on the day the list gains a
 * heading; below ~40 a 2,563-project list shatters into 60+ near-identical
 * pages that compete with each other for the same query and give a reader
 * nothing to scroll.
 */
export const PAGE_SIZE = 60;

/** never zero: a listing that exists has a page 1, even if it were empty */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

export function pageSlice<T>(items: T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

/** 1-based index of the first row on a page, for "projects 61–120" copy */
export const firstOnPage = (page: number) => (page - 1) * PAGE_SIZE + 1;

/** a rendered slot in the numbered nav: a page, or a run that was elided */
export type PageLink = number | "gap";

/**
 * The numbers to render around `current`.
 *
 * First and last are always present, so the two ends of a 43-page list are one
 * click from anywhere; the rest is a window. A crawler still reaches every
 * page — the prev/next chain is unbroken and the sitemap lists all of them —
 * but 43 numbers in a row is not a navigation bar anyone reads.
 */
export function pageWindow(
  current: number,
  total: number,
  radius = 2,
): PageLink[] {
  const wanted = new Set<number>([1, total]);
  for (let page = current - radius; page <= current + radius; page++) {
    if (page >= 1 && page <= total) wanted.add(page);
  }

  const links: PageLink[] = [];
  let previous = 0;
  for (const page of [...wanted].sort((a, b) => a - b)) {
    // eliding a single number costs more characters than printing it, and
    // reads worse: "1 … 3" hides exactly one page
    if (previous > 0 && page - previous === 2) links.push(previous + 1);
    else if (previous > 0 && page - previous > 2) links.push("gap");
    links.push(page);
    previous = page;
  }
  return links;
}
