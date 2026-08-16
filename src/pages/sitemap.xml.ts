import type { APIRoute } from "astro";
import { isoDate } from "../lib/format.ts";
import { shardPath, sitemapShards, xmlEscape } from "../lib/sitemap.ts";
import { absolute } from "../lib/urls.ts";

/**
 * The sitemap index. This is the one URL robots.txt advertises and the one to
 * submit to Search Console; the shards under it are never linked directly.
 *
 * No `changefreq` and no `priority`, here or in the shards. Google has said for
 * years that it ignores both, and a `priority` set from a stars ranking would
 * be a number we made up describing pages that are all equally worth crawling.
 * `lastmod` is the only hint in the protocol that is still read, so it is the
 * only one worth being accurate about.
 */

// static output prerenders every route already; stated so that the day an
// adapter is added, these files do not silently turn into server endpoints
export const prerender = true;

export const GET: APIRoute = async () => {
  const shards = await sitemapShards();

  const entries = shards.map((shard, index) => {
    const lastmod = shard.reduce<Date | undefined>(
      (newest, url) => (!newest || url.lastmod > newest ? url.lastmod : newest),
      undefined,
    );
    return [
      "  <sitemap>",
      `    <loc>${xmlEscape(absolute(shardPath(index)))}</loc>`,
      lastmod ? `    <lastmod>${isoDate(lastmod)}</lastmod>` : undefined,
      "  </sitemap>",
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</sitemapindex>",
    "",
  ].join("\n");

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
