/**
 * The URL set, derived once and shared by the index and every shard.
 *
 * Everything here comes out of the same query helpers the routes themselves
 * build from — `listSummaries`, `categoriesForList`, `allRepoIds` — so a page
 * that stops being generated stops being listed in the same build, rather than
 * leaving a 404 in the sitemap for a crawler to find.
 *
 * Pagination is on the same footing: page counts come from `pageCount()`, the
 * function the routes slice with, and the URLs from `listPagePath` /
 * `categoryPagePath`, the functions the pages canonicalise with. A paginated
 * page nobody links from a menu is a page only this file can introduce to a
 * crawler, so getting it wrong here means the extra pages simply do not exist
 * as far as search is concerned.
 */

import { pageCount } from "./pagination.ts";
import {
  allRepoIds,
  categoriesForList,
  listSummaries,
  repoDetail,
  reposForList,
} from "./queries.ts";
import { absolute, categoryPagePath, listPagePath, repoPath } from "./urls.ts";

/**
 * The protocol caps a sitemap at 50,000 URLs / 50MB uncompressed. At 20k
 * repositories plus their category pages we are past a third of that, and the
 * cap is the kind of limit you notice by silently losing the tail of the file,
 * so shards are kept an order of magnitude under it. 5,000 URLs is roughly
 * 400KB of XML — small enough that a shard re-fetch after a nightly crawl is
 * cheap for the crawler too.
 */
export const SHARD_SIZE = 5_000;

export type SitemapUrl = {
  /** absolute, and trailing-slashed to match the page's own canonical */
  loc: string;
  /**
   * Real freshness, not the build clock. A repository page changes when the
   * repository is pushed to; a list or category page changes when anything in
   * it is. Stamping every URL with "today" on every nightly build is how a
   * sitemap teaches a crawler to stop believing its lastmod.
   */
  lastmod: Date;
};

function newer(a: Date | undefined, b: Date): Date {
  return a && a > b ? a : b;
}

const EPOCH = new Date(0);

async function collect(): Promise<SitemapUrl[]> {
  const summaries = await listSummaries();

  const urls: SitemapUrl[] = [];
  /** pushedAt per repository, harvested while walking the lists */
  const pushedAt = new Map<string, Date>();
  let siteNewest = EPOCH;

  for (const summary of summaries) {
    const { entry } = summary;
    const [repos, categories] = await Promise.all([
      reposForList(entry),
      categoriesForList(entry),
    ]);

    /** newest push under each heading path of this list */
    const perCategory = new Map<string, Date>();
    let listNewest = EPOCH;

    for (const repo of repos) {
      pushedAt.set(repo.id, newer(pushedAt.get(repo.id), repo.pushedAt));
      listNewest = newer(listNewest, repo.pushedAt);
      for (const section of repo.sections) {
        perCategory.set(
          section.slug,
          newer(perCategory.get(section.slug), repo.pushedAt),
        );
      }
    }

    // `lastActivity` is the same max computed in sql; prefer it and fall back
    // to the walk above so an entry is never listed without a lastmod
    const listLastmod = summary.lastActivity ?? listNewest;
    siteNewest = newer(siteNewest, listLastmod);

    /**
     * Every page of a listing carries the listing's own lastmod rather than the
     * newest push among the rows it happens to show. Pages are cut out of a
     * star ranking, so one project gaining stars can shuffle rows across every
     * page boundary below it: the whole run really does change together, and
     * claiming otherwise would be the sort of lastmod a crawler learns to
     * ignore.
     */
    for (let page = 1; page <= pageCount(repos.length); page++) {
      urls.push({ loc: listPagePath(entry.slug, page), lastmod: listLastmod });
    }

    for (const category of categories) {
      const lastmod = perCategory.get(category.slug) ?? listLastmod;
      for (let page = 1; page <= pageCount(category.count); page++) {
        urls.push({
          loc: categoryPagePath(entry.slug, category.slug, page),
          lastmod,
        });
      }
    }
  }

  // the /r/ route builds from `allRepoIds`, so the sitemap does too rather than
  // from the union of the lists above: the two differ the moment the database
  // still holds a list that config.yaml has dropped
  for (const id of await allRepoIds()) {
    let pushed = pushedAt.get(id);
    if (!pushed) {
      const detail = await repoDetail(id);
      if (!detail) continue;
      pushed = detail.repo.pushedAt;
    }
    urls.push({ loc: repoPath(id), lastmod: pushed });
  }

  urls.push({
    loc: "/",
    lastmod: siteNewest === EPOCH ? new Date() : siteNewest,
  });

  // Sorting by path makes shard membership a pure function of the URL set: a
  // repository keeps the same shard from build to build unless the set itself
  // changes, so a crawler is not handed 8 rewritten files every night because
  // one project gained a star and reordered the query.
  const deduped = new Map<string, SitemapUrl>();
  for (const url of urls) {
    const seen = deduped.get(url.loc);
    if (seen) seen.lastmod = newer(seen.lastmod, url.lastmod);
    else deduped.set(url.loc, { ...url });
  }

  return [...deduped.values()]
    .sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0))
    .map((url) => ({ ...url, loc: absolute(url.loc) }));
}

let shardsPromise: Promise<SitemapUrl[][]> | undefined;

/**
 * The URL set, chunked. Memoised: the index route and all N shard routes run in
 * the same build process, and re-reading 20k rows once per shard would put the
 * sitemap on the critical path of the build for no reason.
 */
export function sitemapShards(): Promise<SitemapUrl[][]> {
  shardsPromise ??= collect().then((urls) => {
    const shards: SitemapUrl[][] = [];
    for (let i = 0; i < urls.length; i += SHARD_SIZE) {
      shards.push(urls.slice(i, i + SHARD_SIZE));
    }
    // an empty database still needs a valid, if empty, sitemap to point at
    return shards.length > 0 ? shards : [[]];
  });
  return shardsPromise;
}

/** 1-based, because `sitemap-0.xml` reads like an off-by-one bug in a log */
export const shardPath = (index: number) => `/sitemap-${index + 1}.xml`;

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Repository ids are `[A-Za-z0-9._-]` and slugs are `[a-z0-9-]`, so nothing we
 * emit needs escaping today. It is applied anyway because the day a list name
 * with an ampersand slips through, the failure is a sitemap the crawler drops
 * whole for being malformed, with no error anywhere in our build.
 */
export const xmlEscape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
