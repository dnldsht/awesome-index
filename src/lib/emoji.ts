/**
 * Awesome lists and GitHub descriptions are heavy with decorative emoji: a note
 * reads "🚀 RustFS is an open-source, S3-compatible object storage system", a
 * description reads "Node.js JavaScript runtime ✨🐢🚀✨". They carry no
 * information the words next to them do not, and a page of sixty rows each
 * opening on a different pictogram has no typographic rhythm left, so they are
 * dropped on the way into the database.
 *
 * Half of them are not characters at all: github.com renders ":fire:" as an
 * emoji, so awesome-k8s-resources writes its entries as
 * ":green_heart:[Helm](url) :fire::fire::fire: - Helm is a tool for...", which
 * arrives as literal text and has to be matched as such.
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
 * A run of github's ":name:" emoji shortcodes.
 *
 * The colons are the whole of the syntax, so the guards are what keep prose and
 * code intact: a shortcode never touches a word character or another colon on
 * its outside, which is what tells ":fire:" apart from the ":path:" in
 * "std::path::Path", the ":spark-kotlin:" in "com.sparkjava:spark-kotlin:1.0.0"
 * and the ":40:" in a "10:40:35" timestamp. All three are caught by what sits
 * to the *left* of the opening colon, which is why nothing is required of what
 * follows the closing one: ":green_heart:Helm" glues the shortcode straight
 * onto the word it decorates.
 *
 * Consecutive shortcodes share no colon, so ":fire::fire:" is two of them and
 * the run has to be matched whole rather than one at a time, or every second one
 * would look like it is preceded by a colon and survive.
 */
const SHORTCODE_RUN =
  /(?<![\w:]):[a-z0-9][a-z0-9_+-]*:(?::[a-z0-9][a-z0-9_+-]*:)*/g;

/**
 * Separators an emoji used to sit next to: "🔥 - blazing fast" is left as
 * "- blazing fast" once the fire is gone, and a note is not supposed to open on
 * a dash. Sentence punctuation is not in here, since "Rust🦀." has to keep its
 * full stop.
 */
const DANGLING = /^[\s\-–—•·|,:;]+|[\s\-–—•·|,:;]+$/g;

/**
 * The text without its emoji, written as characters or as shortcodes, respaced.
 *
 * Removal leaves no space behind, so "Rust🦀." keeps its full stop and
 * "🍦VanJS" does not gain a leading one; the runs of whitespace that a stripped
 * "⚡ Blazing fast ⚡" leaves collapse afterwards.
 */
export function stripEmoji(input: string): string {
  if (!input) return input;
  return input
    .replace(SHORTCODE_RUN, "")
    .replace(EMOJI_RUN, "")
    .replace(/\s+/g, " ")
    .replace(DANGLING, "")
    .trim();
}
