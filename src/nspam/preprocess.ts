/**
 * Text preprocessing for the nspam classifier.
 *
 * Ported from the Kotlin reference implementation in barrydeen/wisp
 * (`app/src/main/kotlin/com/wisp/app/ml/NSpamPreprocessor.kt`, MIT licensed).
 *
 * Two surfaces come out of this, and the feature extractor uses each for a
 * different n-gram block:
 *
 *   - `rawText` — NFKC only. Feeds the char_wb n-grams, so casing and
 *     invisible characters are still visible to the character model.
 *   - `text` — NFKC, invisible characters stripped, URLs reduced to their
 *     host, lowercased, whitespace collapsed. Feeds the word n-grams.
 */

/**
 * Invisible / bidi-control code points, verbatim from `config.json`'s
 * `invisible_chars`. Spam authors use these to break up filtered words, so
 * they are both counted (a structural feature) and stripped.
 */
export const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  "\u180E",
  "\u200B",
  "\u200C",
  "\u200D",
  "\u200E",
  "\u200F",
  "\u202A",
  "\u202B",
  "\u202C",
  "\u202D",
  "\u202E",
  "\u2060",
  "\u2061",
  "\u2062",
  "\u2063",
  "\u2064",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
  "\uFEFF",
]);

/** Character-class form of {@link INVISIBLE_CHARS}, for regex stripping. */
const INVISIBLE_RE =
  /[\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * URLs are reduced to `http://<host>` so that the model keys on the domain
 * rather than memorizing per-link paths and query strings.
 *
 * No `u` flag: with `i` alone, `[a-z]`-style classes use ASCII-only case
 * folding, matching the Java/Python reference. Adding `u` would switch JS to
 * Unicode simple case folding and start matching oddities like U+212A.
 */
const URL_PATTERN = /https?:\/\/([^\s/]+)(\/\S*)?/gi;

const WHITESPACE_COLLAPSE = /\s+/g;

/** Output of {@link preprocess}. */
export interface Prepared {
  /** Fully normalized text — feeds the word n-grams. */
  text: string;
  /** NFKC-only text — feeds the char_wb n-grams. */
  rawText: string;
  /** Count of invisible characters seen in `rawText`. */
  zeroWidthN: number;
}

/** Count invisible characters (see {@link INVISIBLE_CHARS}) in `text`. */
export function countInvisibleChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (INVISIBLE_CHARS.has(ch)) n++;
  }
  return n;
}

/** Normalize `text` into the two surfaces the feature extractor needs. */
export function preprocess(text: string): Prepared {
  const nfkc = text.normalize("NFKC");
  const zeroWidthN = countInvisibleChars(nfkc);

  let stripped = nfkc.replace(INVISIBLE_RE, "");
  stripped = stripped.replace(
    URL_PATTERN,
    (_m, host: string) => `http://${host.toLowerCase()}`,
  );
  stripped = stripped.toLowerCase();
  stripped = stripped.replace(WHITESPACE_COLLAPSE, " ").trim();

  return { text: stripped, rawText: nfkc, zeroWidthN };
}
