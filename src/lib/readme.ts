import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { stripEmoji } from "./emoji.ts";
import { slugifyPath } from "./slug.ts";
import { resolveTarget, type ResolvedTarget } from "./targets.ts";

/**
 * Bumped whenever a change here makes the parser return something different for
 * the same README. The crawler folds it into the stored digest, so a list whose
 * README has not moved since the last crawl is still re-parsed and rewritten;
 * otherwise an improvement to this file would only reach a list on the day its
 * author happens to edit it.
 */
export const PARSER_VERSION = 6;

export type ParsedItem = {
  /** what the entry points at, and who owns it; see lib/targets.ts */
  target: ResolvedTarget;
  section: string[];
  sectionSlug: string;
  /** the link text, kept for the targets whose id is not a name */
  title: string | null;
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
 * What an entry is about, plus the link that names it.
 *
 * Three shapes, in order of precedence, and the order matters:
 *
 * 1. the entry leads with its repository ("[serde](github.com/serde-rs/serde) —"),
 *    which is how most lists write it;
 * 2. it leads with the project's own site and hangs the repository off a
 *    trailing "([Source Code](...))" or a bare badge, which is how
 *    awesome-selfhosted, awesome-mac and awesome-blender write it, and why
 *    immich, listed as "[Immich](https://immich.app/) ... ([Source
 *    Code](github.com/immich-app/immich))", is a repository row rather than a
 *    website one;
 * 3. it leads with something that is not a repository and offers no source link
 *    at all (gtkmm, GnuTLS, LLDB, Mobilizon), which used to be the end of the
 *    entry and is now a `web` target.
 *
 * (2) is checked before (3) on purpose: a project that tells us where its code
 * is gets the row with stars and a pulse on it, not the one with a hostname. And
 * the source-link fallback still only accepts a link that announces itself as
 * the source, never an arbitrary repository in the prose, because those are
 * almost always a *different* project ("a rewrite of [MB-Lab](...)").
 */
function resolveEntry(
  paragraph: Node,
  definitions: Map<string, string>,
): { display: Node; target: ResolvedTarget } | undefined {
  const links = collectLinks(paragraph).map((node) => {
    const url =
      node.url ??
      (node.identifier ? definitions.get(node.identifier) : undefined);
    return { node, target: url ? resolveTarget(url) : undefined };
  });

  const display = links[0];
  if (!display) return undefined;
  if (display.target?.kind === "github") {
    return { display: display.node, target: display.target };
  }

  const source = links.slice(1).find(({ node, target }) => {
    if (target?.kind !== "github") return false;
    const text = toText(node).trim();
    return text === "" || SOURCE_LINK_TEXT.test(text);
  });
  if (source?.target) return { display: display.node, target: source.target };

  if (!display.target) return undefined;
  return { display: display.node, target: display.target };
}

/**
 * A heading that names the list's own navigation rather than a category of
 * projects. It still closes the headings deeper than itself, it just never
 * becomes part of a path: awesome-scala hangs its "### Database" straight off
 * "## Table of Contents" with no "## Projects" in between, which filed all 269
 * of its projects under "Table of Contents > ...".
 */
const NAVIGATION_HEADING = /^(table of )?contents?$|^toc$/i;

/** one entry, whichever shape the README wrote it in */
type Entry = {
  target: ResolvedTarget;
  /** the link text, which for a non-repository row is the only name it has */
  title: string | null;
  note: string | null;
};

/** the visible text of the naming link, emoji and inner whitespace tidied */
function titleOf(link: Node): string | null {
  return stripEmoji(toText(link)).replace(/\s+/g, " ").trim() || null;
}

/**
 * The entry a node holds, whichever of the three shapes it is written in, or
 * undefined for the vast majority of nodes that hold no entry at all.
 */
function resolveNode(
  node: Node,
  definitions: Map<string, string>,
): Entry | undefined {
  if (node.type === "tableRow") return resolveTableRow(node, definitions);
  if (node.type !== "listItem" && node.type !== "blockquote") return undefined;

  const paragraph = node.children?.find((c) => c.type === "paragraph");
  if (!paragraph) return undefined;

  const entry = resolveEntry(paragraph, definitions);
  if (!entry) return undefined;
  return {
    target: entry.target,
    title: titleOf(entry.display),
    note: extractNote(paragraph, entry.display),
  };
}

/**
 * The entry a table row is about.
 *
 * awesome-scala and awesome-datascience tabulate instead of listing:
 * "| [doobie](url) | Functional JDBC layer for Scala. | ![stars badge] |".
 * remark keeps those rows as `tableRow`, which the list walk never looked at, so
 * awesome-scala contributed 5 of its ~270 projects.
 *
 * The entry is named by the first cell. The note is whichever later cell carries
 * the most prose: the column order is the author's choice, and the activity
 * column flattens to nothing once its badge images are dropped, so the longest
 * cell is the description in both layouts without either being hardcoded.
 */
function resolveTableRow(
  row: Node,
  definitions: Map<string, string>,
): Entry | undefined {
  const cells = (row.children ?? []).filter((c) => c.type === "tableCell");
  const [first, ...rest] = cells;
  if (!first) return undefined;

  // the header row ("Name | Description | GitHub Activity") links nothing
  const entry = resolveEntry(first, definitions);
  if (!entry) return undefined;

  const note = rest
    .map((cell) => stripEmoji(toText(cell)))
    .reduce(
      (longest, text) => (text.length > longest.length ? text : longest),
      "",
    );
  // a one column table puts the prose next to the link, like a list item would
  return {
    target: entry.target,
    title: titleOf(entry.display),
    note: note || extractNote(first, entry.display),
  };
}

/**
 * awesome-emacs ships its list as README.org, and remark reads org-mode as
 * prose: "** Version control" is a bullet rather than a heading, and
 * "[[url][name]]" is plain text, which cost the list its section paths and a
 * third of its projects.
 *
 * Only the three constructs an entry is made of are translated, which is enough
 * for the walk below and keeps this well short of an org parser. In org a "*"
 * in the first column is always a heading, never a bullet, so the rewrite is
 * unambiguous once the file is known to be org.
 */
function orgToMarkdown(source: string): string {
  return source
    .replace(
      // org indents its bullets to sit under their heading, and four spaces of
      // that is an indented code block in markdown, which is what hid most of
      // this list's entries. Nesting is not worth preserving: a sub-entry parses
      // the same whether it is a child or a sibling.
      /^[ \t]+(?=(?:[-+]|\d+[.)])[ \t])/gm,
      "",
    )
    .replace(
      // trailing ":TOC_5:QUOTE:" style tags belong to the heading, not its text
      /^(\*+)[ \t]+(.*?)(?:[ \t]+:[\w@:]+:)?[ \t]*$/gm,
      (_, stars: string, text: string) => `${"#".repeat(stars.length)} ${text}`,
    )
    .replace(
      /\[\[([^[\]]+)\]\[([^[\]]*)\]\]/g,
      (_, url, text) => `[${text}](${url})`,
    )
    .replace(/\[\[([^[\]]+)\]\]/g, (_, url) => `<${url}>`);
}

/** org headings and org links, the pair no markdown file carries by accident */
function looksLikeOrg(source: string): boolean {
  return /^\*+[ \t]/m.test(source) && /\[\[[^[\]]+\]\[/.test(source);
}

/** "[1]: https://github.com/Dead2/zlib-ng" -> {"1" => "https://..."} */
function collectDefinitions(tree: Node): Map<string, string> {
  const definitions = new Map<string, string>();
  visit(tree, (node: Node) => {
    if (node.type !== "definition" || !node.identifier || !node.url) return;
    definitions.set(node.identifier, node.url);
  });
  return definitions;
}

/**
 * Link text that names no project: the side links an entry trails
 * ("([Demo](...), [Website](...))") and the words a list uses for its own
 * plumbing. A badge flattens to no text at all, which counts too.
 */
const GENERIC_TITLE =
  /^(demo|live demo|try ?it( out)?|web ?site|home ?page|official (site|web ?site|page)|docs?|documentation|manual|guide|download|mirror|blog|paper|article|video|talk|slides|link|here|more|readme|wiki)$/i;

/**
 * The headings a list keeps for itself: what licence it is published under, how
 * to contribute to it, who did. The links under them are about the list, not
 * entries in it, and awesome-selfhosted's "List of Licenses" is 40 spdx.org
 * pages that would otherwise become 40 rows.
 *
 * Whole-heading matches only: "License Management" is a category of software
 * somebody self-hosts, "License" is the footer.
 */
const BOILERPLATE_HEADING =
  /^(licen[cs]es?|list of licen[cs]es|contributing|contribution guidelines|contributions?|contributors?|code of conduct|acknowledg\w*|credits?|thanks|authors?|maintainers?|sponsors?|backers?|disclaimer|footnotes?)$/i;

/**
 * Whether a link that is not a repository is an entry at all.
 *
 * Until now `resolveTarget` returning nothing answered this for free: a badge, a
 * "back to top" anchor, a table-of-contents bullet, a `[[crate](crates.io)]`
 * reference and a footer link were all simply "not a repository". The catch-all
 * provider recognises every one of them, so what used to be a side effect of the
 * github filter has to be stated:
 *
 * - it has to be *named*. A paragraph that opens on a badge has no link text
 *   once the image is dropped, and a row whose name is "https://..." is not a
 *   row anybody scans.
 * - it has to sit under a heading. Everything above the first one is the
 *   list's own front matter (its badges, its "Awesome" cross-links, its
 *   contribution notice), and the headingless bucket the site publishes exists
 *   for lists that write no headings at all, not for preambles.
 * - the heading has to be about projects rather than about the list itself.
 *
 * Repositories are held to none of this, deliberately: they are 88% of the
 * dataset, they have been through 4 parser versions of scrutiny, and tightening
 * the rules under them would silently drop rows the site has always had.
 */
function looksLikeEntry(title: string | null, section: string[]): boolean {
  if (!title || GENERIC_TITLE.test(title)) return false;
  if (section.length === 0) return false;
  return !section.some((heading) => BOILERPLATE_HEADING.test(heading.trim()));
}

/**
 * Extracts the entries an awesome list README links, together with the heading
 * path each one sits under and the target each one points at.
 *
 * Only the paragraph directly owned by an entry is inspected, never its nested
 * lists: otherwise an item with sub-items would also claim every repository
 * linked by its children.
 *
 * An entry is usually a list item, but awesome-java gives each project its own
 * blockquote ("> **[ArchUnit](url)** <kbd>★ 3.8k</kbd><br>Test library..."), so
 * blockquotes owning a paragraph count too, and awesome-scala tabulates its
 * entries, so table rows do as well.
 */
export function parseAwesomeReadme(
  markdown: string,
  options: { exclude?: string } = {},
): ParsedItem[] {
  const source = looksLikeOrg(markdown) ? orgToMarkdown(markdown) : markdown;
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Node;

  const definitions = collectDefinitions(tree);
  /** current heading text by depth, e.g. {2: "Applications", 3: "Audio"} */
  const headings = new Map<number, string>();
  const items: ParsedItem[] = [];
  /** a target may be listed twice under the same section, keep the first note */
  const seen = new Set<string>();
  let position = 0;

  visit(tree, (node: Node) => {
    if (node.type === "heading") {
      const depth = node.depth ?? 1;
      for (const known of [...headings.keys()]) {
        if (known >= depth) headings.delete(known);
      }
      const text = toText(node).trim();
      if (text && !NAVIGATION_HEADING.test(text)) headings.set(depth, text);
      return;
    }

    const resolved = resolveNode(node, definitions);
    if (!resolved) return;
    const { target, title, note } = resolved;
    // the list's own repository, which every list links from its own header
    if (target.kind === "github" && target.id === options.exclude) return;

    // depth 1 is the list's own title ("# Awesome Rust"), it would prefix
    // every single path without telling the reader anything
    const section = [...headings.entries()]
      .filter(([depth]) => depth > 1)
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text);

    // a blockquote is only an entry where entries live; the one a list opens
    // with ("> A curated list of awesome Go frameworks...") sits under no
    // heading at all and would otherwise be filed as an uncategorized entry
    if (node.type === "blockquote" && section.length === 0) return;

    if (target.kind !== "github" && !looksLikeEntry(title, section)) return;

    const sectionSlug = slugifyPath(section);
    const key = `${target.id} ${sectionSlug}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      target,
      section,
      sectionSlug,
      // a repository is named by its id; nothing else is
      title: target.kind === "github" ? null : title,
      note,
      position: position++,
    });
  });

  return items;
}

/**
 * The tag block a list appends to every entry: awesome-selfhosted closes each
 * one with "`AGPL-3.0` `Docker`", awesome-blender with "`GPL-3.0`".
 *
 * Inline code is dropped only where it reads as a tag block and not as prose,
 * which is why the text before it has to end a sentence or close a bracket:
 * "...as a data source. `GPL-3.0`" loses its tags, "...until you set `RUST_LOG`"
 * keeps its last word.
 */
function dropTrailingTags(children: Node[]): Node[] {
  let end = children.length;
  let sawTag = false;
  while (end > 0) {
    const node = children[end - 1]!;
    if (node.type === "inlineCode") {
      sawTag = true;
      end--;
    } else if (toText(node).trim() === "") {
      end--;
    } else break;
  }
  if (!sawTag) return children;

  const before = children.slice(0, end).map(toText).join("").trimEnd();
  if (before && !/[.)!?:\]]$/.test(before)) return children;
  return children.slice(0, end);
}

/**
 * The trailing bundle of side links: "([Demo](...), [Source Code](...))" flattens
 * to "(Demo, Source Code)", which awesome-selfhosted hangs off every entry.
 *
 * Only a parenthesis whose every comma separated part is the text of a link in
 * the same paragraph is dropped, so prose keeps its own asides; immich's note
 * ends at "(alternative to Google Photos)".
 */
function dropTrailingLinkRefs(note: string, linkTexts: Set<string>): string {
  let out = note;
  for (;;) {
    const match = out.match(/\s*\(([^()]*)\)$/);
    if (!match) return out;
    const parts = match[1]!.split(",").map((p) => p.trim().toLowerCase());
    if (!parts.every((p) => p && linkTexts.has(p))) return out;
    out = out.slice(0, match.index).trimEnd();
  }
}

/**
 * The prose the author wrote after the link, minus the link text, the
 * separators and the decorative emoji.
 *
 * Emoji go before the separators are peeled rather than after: "🔥 - blazing
 * fast" would otherwise be left opening on the dash that used to sit behind the
 * pictogram.
 */
function extractNote(paragraph: Node, link: Node): string | null {
  const kept = dropTrailingTags(paragraph.children ?? []);
  const full = stripEmoji(kept.map(toText).join(""));
  const linkText = stripEmoji(toText(link));

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

  const linkTexts = new Set(
    collectLinks(paragraph)
      .map((node) => stripEmoji(toText(node)).toLowerCase())
      .filter(Boolean),
  );
  return dropTrailingLinkRefs(note.trim(), linkTexts).trim() || null;
}
