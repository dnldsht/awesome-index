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

function findFirstLink(node: Node): Node | undefined {
  if (node.type === "link") return node;
  for (const child of node.children ?? []) {
    const found = findFirstLink(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Extracts the repositories linked from an awesome list README, together with
 * the heading path each one sits under.
 *
 * Only the paragraph directly owned by a list item is inspected, never its
 * nested lists: otherwise an item with sub-items would also claim every
 * repository linked by its children.
 */
export function parseAwesomeReadme(
  markdown: string,
  options: { exclude?: string } = {},
): ParsedItem[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(markdown) as Node;

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

    if (node.type !== "listItem") return;

    const paragraph = node.children?.find((c) => c.type === "paragraph");
    if (!paragraph) return;

    const link = findFirstLink(paragraph);
    if (!link?.url) return;

    const repoId = normalizeRepoId(link.url);
    if (!repoId || repoId === options.exclude) return;

    // depth 1 is the list's own title ("# Awesome Rust"), it would prefix
    // every single path without telling the reader anything
    const section = [...headings.entries()]
      .filter(([depth]) => depth > 1)
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text);

    const sectionSlug = slugifyPath(section);
    const key = `${repoId} ${sectionSlug}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      repoId,
      section,
      sectionSlug,
      note: extractNote(paragraph, link),
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
