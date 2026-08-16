import type { APIRoute } from "astro";
import { isoDate } from "../lib/format.ts";
import { SHARD_SIZE, sitemapShards, xmlEscape } from "../lib/sitemap.ts";

/**
 * One shard of the sitemap, at most `SHARD_SIZE` URLs. Reached only through
 * `/sitemap.xml`.
 */

export const prerender = true;

export async function getStaticPaths() {
  // `import.meta.env.SITE` rather than `Astro.site`: getStaticPaths runs
  // outside a render, where there is no `Astro` global to read the site from.
  // Nothing here needs the origin anyway, the shard count is a data question.
  const shards = await sitemapShards();
  return shards.map((_, index) => ({ params: { shard: String(index + 1) } }));
}

export const GET: APIRoute = async ({ params }) => {
  const shards = await sitemapShards();
  const shard = shards[Number(params.shard) - 1];

  if (!shard) {
    return new Response("not found", { status: 404 });
  }
  if (shard.length > SHARD_SIZE) {
    throw new Error(
      `sitemap shard ${params.shard} holds ${shard.length} URLs, over the ${SHARD_SIZE} limit`,
    );
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...shard.map((url) =>
      [
        "  <url>",
        `    <loc>${xmlEscape(url.loc)}</loc>`,
        `    <lastmod>${isoDate(url.lastmod)}</lastmod>`,
        "  </url>",
      ].join("\n"),
    ),
    "</urlset>",
    "",
  ].join("\n");

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
