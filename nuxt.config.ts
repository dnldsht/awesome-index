import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SITE } from "./app/utils/site.ts";

/*
 * Static output, no server, and there will not be one. `nuxt generate`
 * prerenders the home page and one document per list; everything below that
 * (sorting, filtering, the table of contents) happens in the browser against a
 * shard it already holds. See DESIGN.md, "Architecture".
 */

const root = fileURLToPath(new URL(".", import.meta.url));

/*
 * Where the shards live.
 *
 * In production they are `public/data/*.json`, which Nuxt already serves at
 * `/data/` because `public/` is the public directory. Until the shard builder
 * lands (Wave 1 C) that directory is empty, so we mount `fixtures/` at the same
 * URL instead and the whole front end runs against the fixture without a single
 * `if (import.meta.dev)` anywhere in the app code. The moment `public/data/`
 * exists this branch stops firing and nothing else changes.
 */
const shards = `${root}public/data`;
const fixtures = `${root}fixtures`;
const usingFixtures = !existsSync(`${shards}/front-page.json`);
const dataDir = usingFixtures ? fixtures : shards;

/*
 * Which list routes to prerender. `front-page.json` carries the list index, so
 * it is also the route manifest, one less thing to keep in step by hand.
 *
 * Routes are filtered to the shards that actually exist. In fixture mode that
 * is `/golang` alone, which is the honest answer: prerendering the other 79
 * would emit pages whose data request 404s. The filter dissolves on its own
 * once every shard is built.
 */
function listRoutes(): string[] {
  const index = `${dataDir}/front-page.json`;
  if (!existsSync(index)) return [];
  const { lists } = JSON.parse(readFileSync(index, "utf8")) as {
    lists: { slug: string }[];
  };
  return lists
    .filter((l) => existsSync(`${dataDir}/${l.slug}.json`))
    .map((l) => `/${l.slug}`);
}

const routes = ["/", ...listRoutes()];

export default defineNuxtConfig({
  ssr: true,

  /*
   * Every row is in the prerendered HTML, read from the shard at build time
   * (`app/utils/data.ts`), so the 80 indexable pages hold what a crawler came
   * for. `crawlLinks: false` keeps the route list the one computed above.
   */
  nitro: {
    preset: "static",
    prerender: {
      crawlLinks: false,
      /*
       * `golang.html`, not `golang/index.html`. GitHub Pages serves the first
       * at `/golang` and the second only behind a 301 to `/golang/`, which
       * left every canonical and sitemap entry pointing at a redirect.
       */
      autoSubfolderIndex: false,
      routes: [...routes, "/sitemap.xml"],
      failOnError: true,
    },
    publicAssets: usingFixtures
      ? [{ dir: fixtures, baseURL: "/data", maxAge: 0 }]
      : [],
  },

  app: {
    head: {
      htmlAttrs: { lang: "en" },
      link: [{ rel: "icon", href: "/favicon.svg" }],
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        /*
         * Tells the UA both themes exist, so form controls, scrollbars and the
         * overscroll gutter follow the page instead of staying light.
         */
        { name: "color-scheme", content: "light dark" },
        /*
         * One card for the whole site. `public/og.png` is a static render of
         * the nameplate rather than one image per list. The list pages now
         * hold their data at prerender time, so a per-list card is possible;
         * it is not built because nothing yet says it would earn its keep.
         */
        { property: "og:site_name", content: "awesome index" },
        { property: "og:type", content: "website" },
        { property: "og:image", content: `${SITE}/og.png` },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
      /*
       * Umami, self-hosted. No cookies, no fingerprint, no identifier that
       * outlives the visit, which is why there is no banner asking permission
       * to set one, and why the footer can describe it in a sentence instead of
       * a policy. `defer` so it never delays the shard fetch the page actually
       * needs.
       */
      script: [
        {
          src: "https://umami.donld.me/script.js",
          "data-website-id": "8b350941-9854-4caa-b6ac-7f3456f2d310",
          defer: true,
        },
      ],
    },
  },

  /*
   * Two families, self-hosted. Source Serif 4 as the variable weight axis only
   * (no optical-size axis: one file, and the weight axis is the part that
   * earns its keep; see `tokens.css`). IBM Plex Mono at 400 and 500, latin
   * subset, because the mono only ever sets figures and short labels.
   */
  css: [
    "@fontsource-variable/source-serif-4/wght.css",
    "@fontsource/ibm-plex-mono/latin-400.css",
    "@fontsource/ibm-plex-mono/latin-500.css",
    "~/assets/css/tokens.css",
    "~/assets/css/base.css",
  ],

  /*
   * The payload carries no data (see `app/utils/data.ts`), so extracting it
   * would only add a `golang/` directory beside `golang.html`, and a static
   * host that finds a directory at `/golang` redirects to `/golang/`.
   */
  experimental: { payloadExtraction: false },

  devtools: { enabled: true },
  telemetry: false,

  runtimeConfig: {
    /* server-only, for `server/routes/sitemap.xml.ts`; never reaches the client */
    routes,
    /* server-only, for `app/utils/data.ts`: where prerender reads shards from */
    dataDir,
    public: {
      /* surfaced so the list page can say why a shard is missing */
      usingFixtures,
    },
  },
});
