import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { slugifyPath } from "./slug.ts";

/**
 * github.com paths shaped like <owner>/<repo> that are not repositories.
 * Awesome lists link to plenty of them (github.com/sponsors/..., /topics/...).
 */
const RESERVED_OWNERS = new Set([
  "about",
  "account",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "dashboard",
  "enterprise",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "stars",
  "topics",
  "trending",
  "users",
  "watching",
]);

export type ParsedItem = {
  repoId: string;
  section: string[];
  sectionSlug: string;
  note: string | null;
  position: number;
};

/** minimal shape of the mdast nodes we walk, avoids depending on @types/mdast */
type Node = {
  type: string;
  value?: string;
  url?: string;
  depth?: number;
  /** set on `linkReference` and `definition`, ties "[name][1]" to "[1]: url" */
  identifier?: string;
  children?: Node[];
};

/**
 * "https://github.com/hyperium/hyper/tree/master#readme" -> "hyperium/hyper".
 * Returns undefined for anything that is not a repository URL, which is how
 * anchors, badges pointing at shields.io and github.com/sponsors links drop out.
 */
export function normalizeRepoId(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return undefined;
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "github.com") return undefined;

  const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return undefined;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return undefined;

  const name = repo.replace(/\.git$/i, "").replace(/\.+$/, "");
  if (!name) return undefined;
  return `${owner}/${name}`;
}

/** flattens a node to its visible text, dropping images so alt text of badges does not leak in */
function toText(node: Node): string {
  if (node.type === "text" || node.type === "inlineCode")
    return node.value ?? "";
  if (node.type === "image" || node.type === "html") return "";
  if (node.children) return node.children.map(toText).join("");
  return "";
}

/**
 * Every link, or reference to one, in order: awesome-c and awesome-scala write
 * their entries as "[zlib-ng][1]" and collect every url in a block of
 * definitions at the end of the file, which remark keeps as `linkReference`
 * nodes.
 */
function collectLinks(node: Node, out: Node[] = []): Node[] {
  if (node.type === "link" || node.type === "linkReference") out.push(node);
  for (const child of node.children ?? []) collectLinks(child, out);
  return out;
}

/**
 * Link text that means "the code lives here" rather than naming a project.
 * A badge has no text at all once its image is dropped, which counts too.
 */
const SOURCE_LINK_TEXT =
  /^(source(\s*code)?|code|git|repo(sitory)?|github(\s+repo(sitory)?)?|open[-\s]?source)$/i;

/**
 * The repository an entry is about, plus the link that names it.
 *
 * Most lists lead with the repository ("[serde](github.com/serde-rs/serde) —"),
 * but awesome-selfhosted, awesome-mac and awesome-blender lead with the
 * project's own website and hang the repository off a trailing
 * "([Source Code](…))" or a bare badge — which is why immich, listed as
 * "[Immich](https://immich.app/) … ([Source Code](github.com/immich-app/immich))",
 * used to drop out entirely.
 *
 * The fallback only accepts a link that announces itself as the source, never
 * an arbitrary repository mentioned in the prose: those are almost always a
 * *different* project ("a rewrite of [MB-Lab](…)").
 */
function resolveEntry(
  paragraph: Node,
  definitions: Map<string, string>,
): { display: Node; repoId: string } | undefined {
  const links = collectLinks(paragraph).map((node) => {
    const url =
      node.url ??
      (node.identifier ? definitions.get(node.identifier) : undefined);
    return { node, repoId: url ? normalizeRepoId(url) : undefined };
  });

  const display = links[0];
  if (!display) return undefined;
  if (display.repoId) return { display: display.node, repoId: display.repoId };

  const source = links.slice(1).find(({ node, repoId }) => {
    if (!repoId) return false;
    const text = toText(node).trim();
    return text === "" || SOURCE_LINK_TEXT.test(text);
  });
  if (!source?.repoId) return undefined;
  return { display: display.node, repoId: source.repoId };
}

/** "[1]: https://github.com/Dead2/zlib-ng" -> {"1" => "https://…"} */
function collectDefinitions(tree: Node): Map<string, string> {
  const definitions = new Map<string, string>();
  visit(tree, (node: Node) => {
    if (node.type !== "definition" || !node.identifier || !node.url) return;
    definitions.set(node.identifier, node.url);
  });
  return definitions;
}

/**
 * Extracts the repositories linked from an awesome list README, together with
 * the heading path each one sits under.
 *
 * Only the paragraph directly owned by an entry is inspected, never its nested
 * lists: otherwise an item with sub-items would also claim every repository
 * linked by its children.
 *
 * An entry is usually a list item, but awesome-java gives each project its own
 * blockquote ("> **[ArchUnit](url)** <kbd>★ 3.8k</kbd><br>Test library…"), so
 * blockquotes owning a paragraph count too.
 */
export function parseAwesomeReadme(
  markdown: string,
  options: { exclude?: string } = {},
): ParsedItem[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(markdown) as Node;

  const definitions = collectDefinitions(tree);
  /** current heading text by depth, e.g. {2: "Applications", 3: "Audio"} */
  const headings = new Map<number, string>();
  const items: ParsedItem[] = [];
  /** a repo may be listed twice under the same section, keep the first note */
  const seen = new Set<string>();
  let position = 0;

  visit(tree, (node: Node) => {
    if (node.type === "heading") {
      const depth = node.depth ?? 1;
      for (const known of [...headings.keys()]) {
        if (known >= depth) headings.delete(known);
      }
      const text = toText(node).trim();
      if (text) headings.set(depth, text);
      return;
    }

    if (node.type !== "listItem" && node.type !== "blockquote") return;

    const paragraph = node.children?.find((c) => c.type === "paragraph");
    if (!paragraph) return;

    const entry = resolveEntry(paragraph, definitions);
    if (!entry || entry.repoId === options.exclude) return;
    const { repoId } = entry;

    // depth 1 is the list's own title ("# Awesome Rust"), it would prefix
    // every single path without telling the reader anything
    const section = [...headings.entries()]
      .filter(([depth]) => depth > 1)
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text);

    // a blockquote is only an entry where entries live; the one a list opens
    // with ("> A curated list of awesome Go frameworks…") sits under no
    // heading at all and would otherwise be filed as an uncategorized entry
    if (node.type === "blockquote" && section.length === 0) return;

    const sectionSlug = slugifyPath(section);
    const key = `${repoId} ${sectionSlug}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      repoId,
      section,
      sectionSlug,
      note: extractNote(paragraph, entry.display),
      position: position++,
    });
  });

  return items;
}

/** the prose the author wrote after the link, minus the link text and separators */
function extractNote(paragraph: Node, link: Node): string | null {
  const full = toText(paragraph).replace(/\s+/g, " ").trim();
  const linkText = toText(link).replace(/\s+/g, " ").trim();

  let note = full;
  if (linkText && full.startsWith(linkText)) {
    note = full.slice(linkText.length);
  }

  // awesome-rust and friends follow the link with registry references before
  // the prose: "[serde](repo) [[crate](crates.io)] - Serialization framework".
  // Peel separators and bracketed refs until neither matches.
  let previous: string;
  do {
    previous = note;
    note = note.replace(/^[\s\-–—:·|,.]+/, "");
    note = note.replace(/^\[[^\]]*\]/, "");
  } while (note !== previous);

  return note.trim() || null;
}
