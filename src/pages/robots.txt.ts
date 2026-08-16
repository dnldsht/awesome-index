import type { APIRoute } from "astro";
import { absolute } from "../lib/urls.ts";

/**
 * Written from `site` rather than checked in as a static file, because the
 * `Sitemap:` line has to be absolute — it is the one URL in robots.txt that
 * cannot be a path — and hardcoding the host is how it ends up still pointing
 * at a staging domain a year later.
 *
 * Nothing is disallowed. Every route this site builds is a page we want in the
 * index, and a `Disallow` on the asset directories would only stop crawlers
 * from fetching the CSS they render the page with.
 */

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(
    [
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${absolute("/sitemap.xml")}`,
      "",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
