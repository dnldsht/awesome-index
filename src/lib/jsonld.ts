/**
 * Structured data as a `<script type="application/ld+json">` body.
 *
 * `JSON.stringify` produces valid JSON and *not* something safe to drop into
 * markup: it escapes quotes and backslashes, and leaves `<` and `>` alone. An
 * HTML parser does not know it is looking at JSON — it ends the script element
 * at the first `</script`, whatever the quoting around it — so a single string in
 * the payload can close the block early and have the rest of itself parsed as
 * elements.
 *
 * Which is not a theoretical worry here. Everything in this JSON-LD is written by
 * strangers: the heading paths, and now the link text an entry is named by, come
 * out of 88 READMEs that accept pull requests from anybody. A curator, or anyone
 * whose one-line PR is merged, can call a project
 * `Basel</script><img src=x onerror=...>` and have it run on every page that
 * entry appears on.
 *
 * `\u003c` is how JSON spells `<` inside a string, so a JSON parser reads exactly
 * the same document while the HTML tokenizer never sees a tag at all. `&` goes
 * the same way, and U+2028 / U+2029 because they are legal in a JSON string and
 * not in a JavaScript one, which matters the day this payload is read by
 * something that evaluates rather than parses it.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
