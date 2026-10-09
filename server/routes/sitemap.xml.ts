import { SITE } from "~~/app/utils/site";

/*
 * The sitemap, prerendered to a file like every other route. It lists exactly
 * what `nuxt.config.ts` prerenders, from the same array, so a list without a
 * shard is absent here for the same reason it is absent from the build. No
 * query variants: they all canonicalise to the bare list URL.
 */
export default defineEventHandler((event) => {
  const routes = useRuntimeConfig().routes as string[];
  const urls = routes
    .map((path) => `  <url><loc>${SITE}${path}</loc></url>`)
    .join("\n");
  setHeader(event, "content-type", "application/xml");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
});
