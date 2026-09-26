/*
 * Turning the tuple into the handful of short strings a 32px row can hold.
 *
 * Every function here is called once per row per render (2,829 times on
 * `avelino/awesome-go`), so they are plain and allocate little, and the two
 * that consult a table consult a plain object rather than a Map built at call
 * time.
 */

/** GitHub stars, grouped. Exact, not compacted: `4,627` is a fact and `4.6k`
 *  is a rounding, and the mono column is wide enough for the corpus maximum
 *  (`150,264`) either way. */
const group = new Intl.NumberFormat("en-US");

export function stars(n: number): string {
  return group.format(n);
}

/** A net star delta, signed. `+412`, `-9`, and `0` stays `0`: a week with no
 *  change is a measurement, not an absence. */
export function delta(n: number): string {
  return n > 0 ? `+${group.format(n)}` : group.format(n);
}

/*
 * GitHub reports a licence by its full name ("BSD 3-Clause \"New\" or
 * \"Revised\" License"), which is forty characters of a 4.75rem column. The
 * table covers what GitHub's own picker offers; the fallback below catches
 * anything it does not, because the corpus is 80 lists and this file only ever
 * sees one of them at a time.
 */
const LICENSE: Record<string, string> = {
  "MIT License": "MIT",
  "Apache License 2.0": "Apache-2",
  "Mozilla Public License 2.0": "MPL-2",
  "GNU General Public License v2.0": "GPL-2",
  "GNU General Public License v3.0": "GPL-3",
  "GNU Affero General Public License v3.0": "AGPL-3",
  "GNU Lesser General Public License v2.1": "LGPL-2.1",
  "GNU Lesser General Public License v3.0": "LGPL-3",
  'BSD 2-Clause "Simplified" License': "BSD-2",
  'BSD 3-Clause "New" or "Revised" License': "BSD-3",
  'BSD 4-Clause "Original" or "Old" License': "BSD-4",
  "BSD Zero Clause License": "0BSD",
  "Boost Software License 1.0": "BSL-1",
  "Eclipse Public License 1.0": "EPL-1",
  "Eclipse Public License 2.0": "EPL-2",
  "European Union Public License 1.2": "EUPL-1.2",
  "ISC License": "ISC",
  "zlib License": "Zlib",
  "The Unlicense": "Unlicense",
  "Universal Permissive License v1.0": "UPL-1",
  "Artistic License 2.0": "Artistic-2",
  "Creative Commons Zero v1.0 Universal": "CC0",
  "Creative Commons Attribution 4.0 International": "CC-BY-4",
  "Creative Commons Attribution Share Alike 4.0 International": "CC-BY-SA-4",
  "Do What The F*ck You Want To Public License": "WTFPL",
  "Open Software License 3.0": "OSL-3",
  "Microsoft Public License": "MS-PL",
  "Microsoft Reciprocal License": "MS-RL",
  "SIL Open Font License 1.1": "OFL-1.1",
  "Mulan Permissive Software License, Version 2": "MulanPSL-2",
  "Blue Oak Model License 1.0.0": "BlueOak-1",
  "PostgreSQL License": "PostgreSQL",
  "Academic Free License v3.0": "AFL-3",
  "LaTeX Project Public License v1.3c": "LPPL-1.3c",
  "GNU Free Documentation License v1.3": "GFDL-1.3",
  Other: "other",
};

/** The licence, short enough for the column. Unknown full names lose the word
 *  "License" and any parenthetical, which is wrong for nothing in the corpus
 *  and merely long for whatever GitHub adds next. */
export function license(full: string | null): string {
  if (!full) return "";
  const known = LICENSE[full];
  if (known) return known;
  return full
    .replace(/\s*\(.*\)\s*/g, " ")
    .replace(/\bLicen[cs]e\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long since the last push, in five characters or fewer.
 *
 * The label (`active` / `slow` / `stalled`) is our judgement and this is the
 * fact it was made from; DESIGN.md requires the two to appear together so a
 * reader can disagree with the first while looking at the second. Until the
 * activity pass lands, every state is null and this age is the entire column,
 * which is the honest arrangement, not a degraded one.
 */
export function age(
  unixSeconds: number | null,
  now = Date.now() / 1000,
): string {
  if (unixSeconds == null) return "";
  const d = Math.max(0, now - unixSeconds);
  if (d < DAY) return "today";
  const days = Math.round(d / DAY);
  if (days < 31) return `${days}d`;
  const months = Math.round(d / (DAY * 30.44));
  if (months < 24) return `${months}mo`;
  return `${Math.round(d / (DAY * 365.25))}y`;
}

/** The full date, for the expanded row: the unrounded version of `age`. */
export function isoDate(unixSeconds: number | null): string {
  if (unixSeconds == null) return "";
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** The host of a web row, `www.` dropped. For 260 of golang's rows this is the
 *  only durable fact we hold: they carry no stars, no language and no pulse,
 *  and where a link points is what a reader judges it by. */
export function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** `"avelino/awesome-go"` → `["avelino/", "awesome-go"]`, so the row can dim
 *  the owner and set the repository in the name weight. Anything without a
 *  slash (or a web row's id, which is a URL) comes back owner-less. */
export function owner(id: string, kind: "github" | "web"): string {
  if (kind !== "github") return "";
  const i = id.indexOf("/");
  return i < 0 ? "" : id.slice(0, i + 1);
}

/** `1, "person", "people"` → `"1 person"`. The health section counts four
 *  things whose plural matters, and none of them is worth a ternary in the
 *  template. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${group.format(n)} ${n === 1 ? one : many}`;
}
