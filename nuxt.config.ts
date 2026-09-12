import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * Static output, no server, and there will not be one. `nuxt generate`
 * prerenders the home page and one document per list; everything below that —
 * sorting, filtering, the table of contents — happens in the browser against a
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
 * it is also the route manifest — one less thing to keep in step by hand.
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

export default defineNuxtConfig({
  ssr: true,

  /*
   * The prerendered HTML is a skeleton: the rows arrive from the JSON on the
   * client. DESIGN.md records this as a deliberate deferral with a real cost —
   * the 80 indexable pages currently hold nothing for a crawler — and as a
   * build-time switch rather than a rewrite, which is what `crawlLinks: false`
   * plus a client-only fetch keeps true.
   */
  nitro: {
    preset: "static",
    prerender: {
      crawlLinks: false,
      routes: ["/", ...listRoutes()],
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
      ],
    },
  },

  /*
   * Two families, self-hosted. Source Serif 4 as the variable weight axis only
   * (no optical-size axis: one file, and the weight axis is the part that
   * earns its keep — see `tokens.css`). IBM Plex Mono at 400 and 500, latin
   * subset, because the mono only ever sets figures and short labels.
   */
  css: [
    "@fontsource-variable/source-serif-4/wght.css",
    "@fontsource/ibm-plex-mono/latin-400.css",
    "@fontsource/ibm-plex-mono/latin-500.css",
    "~/assets/css/tokens.css",
    "~/assets/css/base.css",
  ],

  devtools: { enabled: false },
  telemetry: false,

  runtimeConfig: {
    public: {
      /* surfaced so the list page can say why a shard is missing */
      usingFixtures,
    },
  },
});
