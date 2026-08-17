/**
 * Awesome lists and GitHub descriptions are heavy with decorative emoji: a note
 * reads "🚀 RustFS is an open-source, S3-compatible object storage system", a
 * description reads "Node.js JavaScript runtime ✨🐢🚀✨". They carry no
 * information the words next to them do not, and a page of sixty rows each
 * opening on a different pictogram has no typographic rhythm left, so they are
 * dropped on the way into the database.
 */

/**
 * Pictographic but read as typography rather than decoration, and part of the
 * name where they appear ("Unreal Engine®"), so they stay.
 */
const KEEP = "©®™";

/**
 * One emoji, with everything that can be glued onto it: a skin tone modifier, a
 * variation selector picking the emoji or the text presentation, the enclosing
 * keycap, and the zero-width joiners that bind a sequence like "🙇‍♂️" into a
 * single glyph. Matching the whole run at once matters: leaving a stray joiner
 * or selector behind puts an invisible character in the middle of a sentence.
 *
 * Flags are pairs of regional indicators, which are not `Extended_Pictographic`
 * and so need their own range, and a keycap starts on a plain digit.
 */
const EMOJI_RUN = new RegExp(
  `(?:[\\p{Extended_Pictographic}--[${KEEP}]]|[\\u{1F1E6}-\\u{1F1FF}]|[0-9#*]\\uFE0F?\\u20E3)` +
    `[\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}\\uFE0E\\uFE0F\\u20E3\\u200D]*`,
  "gv",
);

/**
 * Separators an emoji used to sit next to: "🔥 - blazing fast" is left as
 * "- blazing fast" once the fire is gone, and a note is not supposed to open on
 * a dash. Sentence punctuation is not in here, since "Rust🦀." has to keep its
 * full stop.
 */
const DANGLING = /^[\s\-–—•·|,:;]+|[\s\-–—•·|,:;]+$/g;

/**
 * The text without its emoji, respaced.
 *
 * Removal leaves no space behind, so "Rust🦀." keeps its full stop and
 * "🍦VanJS" does not gain a leading one; the runs of whitespace that a stripped
 * "⚡ Blazing fast ⚡" leaves collapse afterwards.
 */
export function stripEmoji(input: string): string {
  if (!input) return input;
  return input
    .replace(EMOJI_RUN, "")
    .replace(/\s+/g, " ")
    .replace(DANGLING, "")
    .trim();
}
