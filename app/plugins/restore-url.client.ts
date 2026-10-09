/*
 * Puts the query string back in the address bar after hydration.
 *
 * A list page is prerendered once, at its bare path, and opened at any of its
 * query variants (`/golang?sort=stars&q=orm`). Nuxt hydrates against the path
 * it prerendered and then restores the real route, but it sets the router's
 * current route *before* calling `router.replace`, so vue-router rejects that
 * replace as a duplicate and the URL is never written back. The page then
 * shows the reader's state under a bare `/golang`, and the next control they
 * touch rewrites the URL from that.
 *
 * The router holds the right route; this only makes the address bar agree. It
 * goes through the router's own history rather than `window.history`, which
 * keeps a copy of the current location and writes that copy back over the
 * entry on the next push, so Back would land on the bare path again. It runs
 * after Nuxt's own restore, which registers on `app:created`.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter();
  nuxtApp.hooks.hookOnce("app:created", () => {
    nuxtApp.hooks.hookOnce("app:suspense:resolve", () => {
      const want = router.currentRoute.value.fullPath;
      if (router.options.history.location !== want)
        router.options.history.replace(want);
    });
  });
});
