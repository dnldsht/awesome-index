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
      /*
       * "C", "C++" and "C#" are three different languages, and
       * awesome-machine-learning writes all three as headings with seven
       * subsections each. Collapsing the punctuation first put every C++ library
       * on a page called "C" and every C# one after it, silently, because
       * `categoriesForList` groups by this slug and takes whichever heading text
       * a row happened to carry. So the symbols that carry the distinction are
       * spelled out before the rest is collapsed.
       */
      .replace(/\+/g, "-plus-")
      .replace(/#/g, "-sharp-")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/** "Applications › Audio" -> "applications/audio" */
export function slugifyPath(section: string[]): string {
  return section.map(slugify).join("/");
}
