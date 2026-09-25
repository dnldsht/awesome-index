/**
 * Light or dark, for this visit only.
 *
 * The default is the operating system's, which is the preference the reader
 * already expressed somewhere better than a button on this page. The toggle
 * overrides it for the session and deliberately does not remember: DESIGN.md
 * puts `localStorage` out of scope for this phase, and a preference that
 * survives a reload is the thing that list is about.
 */
export type Theme = "auto" | "light" | "dark";

/* One media query per browsing context, not one per component. `useTheme` is
 * called from the app root, the toggle and every expanded row, and a listener
 * per caller would be a slow leak on a page that can open a thousand rows. The
 * flag is module scope and that is safe *because it is only ever set on the
 * client*: on the server the block below never runs, and `useState` keeps the
 * value itself per-request. */
let bound = false;

export function useTheme() {
  const theme = useState<Theme>("theme", () => "auto");
  const system = useState<boolean>("theme:system", () => false);

  if (import.meta.client && !bound) {
    bound = true;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    /* after hydration, not now: the server rendered `false`, and setting it
     * during setup puts the toggle's icon and title out of step with the HTML
     * it is hydrating — which Vue, in production, does not patch */
    onNuxtReady(() => (system.value = mq.matches));
    mq.addEventListener("change", (e) => (system.value = e.matches));
  }

  /**
   * What the reader is actually looking at, with `auto` resolved.
   *
   * Needed because one thing on this page is not styled by us: the star-history
   * SVG arrives with its background baked in, and asking for the wrong one puts
   * a white rectangle in the middle of a charcoal page. Everything else reads
   * the CSS custom properties and never needs to know.
   *
   * False during prerender and on the first tick after hydration, which is
   * correct rather than merely safe: nothing renders against it until the
   * reader has opened a row.
   */
  const dark = computed(() =>
    theme.value === "auto" ? system.value : theme.value === "dark",
  );

  useHead({
    htmlAttrs: {
      "data-theme": computed(() =>
        theme.value === "auto" ? undefined : theme.value,
      ),
    },
  });

  /* auto → the opposite of what the reader is currently seeing */
  function toggle() {
    if (theme.value === "auto") {
      theme.value = dark.value ? "light" : "dark";
    } else {
      theme.value = theme.value === "dark" ? "light" : "dark";
    }
  }

  return { theme, dark, toggle };
}
