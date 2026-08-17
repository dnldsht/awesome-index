// @ts-check
import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import tailwindcss from "@tailwindcss/vite";
import { pagefindDev } from "./src/lib/pagefind-dev.ts";

// https://astro.build/config
export default defineConfig({
  /**
   * Every canonical, every og:url, every <loc> in the sitemap and the Sitemap:
   * line in robots.txt are derived from this through `absolute()` in
   * src/lib/urls.ts, so this is the only place the host is written.
   *
   * A subdomain of a domain we own, and deliberately not the .dev this project
   * is named after: that one is taken by an unrelated project, and pointing our
   * canonicals at a host somebody else serves would tell Google our pages are
   * copies of theirs.
   *
   * It is a temporary address. Moving off it later needs a 301 from every old
   * URL, which GitHub Pages cannot do — but the domain is on Cloudflare, where a
   * single redirect rule on awesome.donld.me/* covers all 3,976 of them. Keep
   * `public/CNAME` in step with whatever this says.
   */
  site: "https://awesome.donld.me",
  output: "static",
  // GitHub Pages 301s /rust to /rust/, so emit the slash we are going to be
  // served at rather than a redirect on every internal link
  trailingSlash: "always",
  integrations: [preact()],
  vite: {
    // pagefindDev only applies to `astro dev`; the build emits the real index
    plugins: [tailwindcss(), pagefindDev()],
  },
});
