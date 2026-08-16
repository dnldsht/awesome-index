// @ts-check
import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  // TODO: point at the real domain before the first deploy, the canonical URLs
  // and the sitemap are both built from this
  site: "https://awesomeindex.dev",
  output: "static",
  // GitHub Pages 301s /rust to /rust/, so emit the slash we are going to be
  // served at rather than a redirect on every internal link
  trailingSlash: "always",
  integrations: [preact()],
  vite: {
    plugins: [tailwindcss()],
  },
});
