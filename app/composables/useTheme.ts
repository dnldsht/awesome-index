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

export function useTheme() {
  const theme = useState<Theme>("theme", () => "auto");

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
      const dark =
        import.meta.client &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      theme.value = dark ? "light" : "dark";
    } else {
      theme.value = theme.value === "dark" ? "light" : "dark";
    }
  }

  return { theme, toggle };
}
