/**
 * URL segment from arbitrary heading text. Awesome list headings carry emoji,
 * ampersands and slashes ("Web Programming / HTTP", "Testing ✅"), all of which
 * have to collapse into something routable and stable across crawls.
 */
export function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      // strip diacritics and anything outside the Basic Latin range (emoji)
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/** "Applications › Audio" -> "applications/audio" */
export function slugifyPath(section: string[]): string {
  return section.map(slugify).join("/");
}
