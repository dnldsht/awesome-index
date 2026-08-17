import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin } from "vite";

/**
 * Serves the Pagefind index to the dev server.
 *
 * Pagefind runs *after* `astro build`, so `/pagefind/` is a directory that only
 * exists inside `dist/`. On `astro dev` nothing serves it and the search island
 * can only ever show its "index is missing" fallback — which is honest, but it
 * means the one page on the site that runs JavaScript is also the one page that
 * cannot be developed.
 *
 * Rather than copying the index into `public/` (where it would be committed, go
 * stale, and then be overwritten in `dist/` by the real thing), this maps the
 * request straight onto the last build's output. Run `pnpm build` once and the
 * dev server has a working search until the dataset changes enough to care.
 */
const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json",
};

export function pagefindDev(outDir = "dist"): Plugin {
  const root = path.resolve(process.cwd(), outDir, "pagefind");
  let warned = false;

  return {
    name: "pagefind-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/pagefind", (req, res, next) => {
        const requested = (req.url ?? "/").split("?")[0] ?? "/";
        const file = path.join(root, decodeURIComponent(requested));

        // a request cannot climb out of the index directory
        if (!file.startsWith(root + path.sep)) return next();

        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          if (!warned) {
            warned = true;
            server.config.logger.warn(
              `[pagefind-dev] no index at ${path.relative(process.cwd(), root)} — ` +
                `run \`pnpm build\` once to make search work in dev`,
            );
          }
          return next();
        }

        res.setHeader(
          "content-type",
          MIME[path.extname(file)] ?? "application/octet-stream",
        );
        // the index is a build artefact the dev server should never cache
        res.setHeader("cache-control", "no-store");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
