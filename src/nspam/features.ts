/**
 * Feature extraction for the nspam classifier.
 *
 * Ported from the Kotlin reference implementation in barrydeen/wisp
 * (`app/src/main/kotlin/com/wisp/app/ml/NSpamFeatures.kt`, MIT licensed),
 * with two deliberate divergences where the Kotlin disagrees with the
 * fixtures the model ships:
 *
 *  1. **Code points, not UTF-16 units.** The Kotlin slices char n-grams with
 *     `String.substring`, which splits surrogate pairs. `hash_fixtures.jsonl`
 *     says otherwise: `"🤖"` yields exactly one 3-gram (bucket 58643), which
 *     is only true if the window walks code points. The model was trained in
 *     Python, where strings are sequences of code points, so the fixtures are
 *     authoritative. The same reasoning applies to every length and ratio in
 *     the structural block.
 *  2. **Unicode whitespace.** Java's `\s` is ASCII-only; Python's and JS's
 *     are not. We follow Python.
 *
 * The layout is fixed by `config.json`:
 *
 *   [0, 131072)            char_wb 3-5-grams, hashed
 *   [131072, 262144)       word 1-2-grams, hashed
 *   [262144, 262161)       17 structural features, averaged over the group
 *   [262161, 262167)       6 group-level features
 */

import { hash32Range } from "./murmur3.ts";
import {
  countInvisibleChars,
  INVISIBLE_CHARS,
  preprocess,
} from "./preprocess.ts";

export const N_CHAR = 131072;
export const N_WORD = 131072;
export const N_STRUCTURAL = 17;
export const N_GROUP = 6;
/** Total feature-vector width. `max_feature_idx` in model.txt is this minus 1. */
export const TOTAL = N_CHAR + N_WORD + N_STRUCTURAL + N_GROUP;

const STRUCT_OFFSET = N_CHAR + N_WORD;
const GROUP_OFFSET = STRUCT_OFFSET + N_STRUCTURAL;

/** A single note to score. Only these three fields affect the result. */
export interface NoteInput {
  content: string;
  tags: string[][];
  created_at: number;
}

// ---------------------------------------------------------------------------
// Patterns
//
// `u` is omitted wherever a pattern relies on `i` over an ASCII class: with
// `u`, JS switches to Unicode simple case folding and `[a-z]` starts matching
// U+212A and friends, which the Python reference does not do.
// ---------------------------------------------------------------------------

const WORD_PATTERN = /[\p{L}\p{N}_]{2,}/gu;
const WHITESPACE = /\s+/g;
const URL_PATTERN = /https?:\/\/([^\s/]+)/gi;
const MENTION_PATTERN =
  /\b(?:nostr:)?(?:npub1|note1|nprofile1|nevent1|naddr1)[0-9a-z]+/gi;
const HASHTAG_PATTERN = /#\w+/g;
const NONWS_TOKEN = /\S+/g;
const EMOJI_PATTERN = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
const UNICODE_DIGIT = /\p{N}/gu;
const UNICODE_PUNCT = /\p{P}/gu;
const UNICODE_LETTER = /\p{L}/gu;
const UNICODE_UPPER = /\p{Lu}/gu;
const TOKENIZE_RE = /\p{L}[\p{L}\p{M}\p{N}_]*|\p{N}+|https?:\/\/\S+|[#@]\w+/gu;

/** Count non-overlapping matches without materializing the match array. */
function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s) !== null) n++;
  return n;
}

/** Number of Unicode code points in `s` (Python's `len`, not JS's `.length`). */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Skip the low half of a surrogate pair so the pair counts once.
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) i++;
    }
    n++;
  }
  return n;
}

/** First `n` code points of `s`. */
function takeCodePoints(s: string, n: number): string {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (count === n) return s.slice(0, i);
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) i++;
    }
    count++;
  }
  return s;
}

const encoder = new TextEncoder();

/**
 * Extracts nspam feature vectors.
 *
 * Stateful on purpose. The vector is 262,167 wide but a note touches only a
 * few hundred entries, so the buffer is allocated once and the touched
 * indices are tracked and zeroed after each score. Allocating a fresh 2 MB
 * `Float64Array` per event would dominate the cost of everything else here.
 *
 * Not reentrant: the buffer returned by {@link extract} is only valid until
 * the next call to {@link extract} or {@link reset}.
 */
export class FeatureExtractor {
  /** Reused feature vector. */
  private readonly values = new Float64Array(TOTAL);
  /** Hashed-block indices written since the last reset; may contain repeats. */
  private touched: number[] = [];
  /** UTF-8 scratch for n-gram hashing, grown on demand. */
  private scratch = new Uint8Array(4096);
  /** Byte offset of each code-point boundary in `scratch`, plus the end. */
  private cpOffsets = new Int32Array(1024);

  /**
   * Build the feature vector for a group of notes.
   *
   * The returned array is owned by this extractor — read it before the next
   * call. Structural features are averaged across the group; group features
   * describe the group itself.
   */
  extract(notes: readonly NoteInput[]): Float64Array {
    this.reset();

    const n = notes.length;
    if (n === 0) return this.values;

    const preps = notes.map((note) => preprocess(note.content));

    this.hashCharWbNgrams(preps.map((p) => p.rawText).join(" "));
    this.hashWordNgrams(preps.map((p) => p.text).join(" "));

    const structuralSums = new Float64Array(N_STRUCTURAL);
    const charLengths: number[] = [];
    const bodyKeys: string[] = [];
    const rawTexts: string[] = [];

    for (const note of notes) {
      const raw = note.content;
      rawTexts.push(raw);

      let bodyKey = "";
      for (const ch of raw) {
        if (!INVISIBLE_CHARS.has(ch)) bodyKey += ch;
      }
      bodyKeys.push(takeCodePoints(bodyKey.trim().toLowerCase(), 200));

      const cpLen = codePointLength(raw);
      addStructural(structuralSums, raw, note.tags, cpLen);
      charLengths.push(cpLen);
    }

    for (let i = 0; i < N_STRUCTURAL; i++) {
      this.values[STRUCT_OFFSET + i] = structuralSums[i] / n;
    }

    this.values[GROUP_OFFSET] = n;
    if (n > 1) {
      let min = notes[0].created_at;
      let max = notes[0].created_at;
      for (const note of notes) {
        if (note.created_at < min) min = note.created_at;
        if (note.created_at > max) max = note.created_at;
      }
      this.values[GROUP_OFFSET + 1] = (max - min) / 3600;
    }

    const uniqueBodies = new Set(bodyKeys.filter((b) => b.length > 0));
    this.values[GROUP_OFFSET + 2] = uniqueBodies.size;

    if (n >= 2) {
      this.values[GROUP_OFFSET + 3] = populationStdDev(charLengths);

      const tokenLists = rawTexts.map((t) => {
        TOKENIZE_RE.lastIndex = 0;
        return t.toLowerCase().match(TOKENIZE_RE) ?? [];
      });

      const firstTokens = tokenLists
        .filter((l) => l.length > 0)
        .map((l) => l[0]);
      if (firstTokens.length > 0) {
        const counts = new Map<string, number>();
        let maxCount = 0;
        for (const token of firstTokens) {
          const c = (counts.get(token) ?? 0) + 1;
          counts.set(token, c);
          if (c > maxCount) maxCount = c;
        }
        this.values[GROUP_OFFSET + 4] = maxCount / n;
      }

      const tokenSets = tokenLists.map((l) => new Set(l));
      let jaccSum = 0;
      let jaccCount = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = tokenSets[i];
          const b = tokenSets[j];
          const union = new Set([...a, ...b]).size;
          if (union > 0) {
            let inter = 0;
            for (const t of a) {
              if (b.has(t)) inter++;
            }
            jaccSum += inter / union;
          }
          jaccCount++;
        }
      }
      if (jaccCount > 0) this.values[GROUP_OFFSET + 5] = jaccSum / jaccCount;
    }

    return this.values;
  }

  /**
   * The feature vector as last built. Owned by this extractor and valid only
   * until the next {@link extract} or {@link reset}.
   */
  get vector(): Float64Array {
    return this.values;
  }

  /** Zero everything written since the last extract. */
  reset(): void {
    for (const idx of this.touched) this.values[idx] = 0;
    this.touched.length = 0;
    this.values.fill(0, STRUCT_OFFSET);
  }

  /**
   * sklearn's `alternate_sign` convention: the bucket is `|h| % n_features`
   * and the increment carries the sign of the hash, so collisions cancel in
   * expectation instead of always accumulating.
   */
  private hashInto(
    data: Uint8Array,
    start: number,
    end: number,
    offset: number,
    nFeatures: number,
  ): void {
    const h = hash32Range(data, start, end);
    const index = offset + (Math.abs(h) % nFeatures);
    this.values[index] += h >= 0 ? 1 : -1;
    this.touched.push(index);
  }

  /** Ensure the UTF-8 scratch buffer holds at least `bytes`. */
  private ensureScratch(bytes: number): void {
    if (this.scratch.length >= bytes) return;
    let size = this.scratch.length;
    while (size < bytes) size *= 2;
    this.scratch = new Uint8Array(size);
  }

  /**
   * Encode `s` into the scratch buffer and record the byte offset of every
   * code-point boundary (plus the end) in `cpOffsets`.
   *
   * Returns the number of code points. Hashing an n-gram is then a byte range
   * `[cpOffsets[i], cpOffsets[i + n])` — no per-n-gram string or array.
   */
  private encodeWithOffsets(s: string): number {
    // Worst case 4 UTF-8 bytes per UTF-16 unit.
    this.ensureScratch(s.length * 4);
    if (this.cpOffsets.length < s.length + 1) {
      this.cpOffsets = new Int32Array(
        Math.max(s.length + 1, this.cpOffsets.length * 2),
      );
    }

    let cp = 0;
    let byte = 0;
    for (let i = 0; i < s.length; i++) {
      this.cpOffsets[cp++] = byte;
      let code = s.charCodeAt(i);
      if (code >= 0xd800 && code < 0xdc00 && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xdc00 && low < 0xe000) {
          code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          i++;
        }
      }
      byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    this.cpOffsets[cp] = byte;

    const { written } = encoder.encodeInto(s, this.scratch);
    // Lone surrogates encode as U+FFFD (3 bytes) and would desync the
    // offsets; fall back to per-n-gram encoding by reporting no code points.
    if (written !== byte) return -1;

    return cp;
  }

  /**
   * sklearn `char_wb`: n-grams are taken within word boundaries, each word
   * padded with a single space on both sides.
   */
  hashCharWbNgrams(text: string): void {
    WHITESPACE.lastIndex = 0;
    const normalized = text.replace(WHITESPACE, " ");
    for (const word of normalized.split(" ")) {
      if (word.length === 0) continue;
      const padded = ` ${word} `;
      const cpCount = this.encodeWithOffsets(padded);
      if (cpCount < 0) {
        this.hashCharWbNgramsSlow(padded);
        continue;
      }
      for (let n = 3; n <= 5; n++) {
        for (let start = 0; start + n <= cpCount; start++) {
          this.hashInto(
            this.scratch,
            this.cpOffsets[start],
            this.cpOffsets[start + n],
            0,
            N_CHAR,
          );
        }
      }
    }
  }

  /** Allocating fallback for text containing lone surrogates. */
  private hashCharWbNgramsSlow(padded: string): void {
    const cps = [...padded];
    for (let n = 3; n <= 5; n++) {
      for (let start = 0; start + n <= cps.length; start++) {
        const bytes = encoder.encode(cps.slice(start, start + n).join(""));
        this.hashInto(bytes, 0, bytes.length, 0, N_CHAR);
      }
    }
  }

  /**
   * sklearn `word` analyzer with `ngram_range=(1, 2)`.
   *
   * Tokens are laid out space-separated in one scratch buffer, which makes a
   * bigram the byte range spanning two adjacent tokens — the separator is
   * already there.
   */
  hashWordNgrams(text: string): void {
    WORD_PATTERN.lastIndex = 0;
    const tokens = text.match(WORD_PATTERN);
    if (!tokens || tokens.length === 0) return;

    const joined = tokens.join(" ");
    this.ensureScratch(joined.length * 4);
    const { written } = encoder.encodeInto(joined, this.scratch);

    // Token byte boundaries within `joined`, separated by one-byte spaces.
    const starts = new Int32Array(tokens.length);
    const ends = new Int32Array(tokens.length);
    let pos = 0;
    for (let i = 0; i < tokens.length; i++) {
      starts[i] = pos;
      pos += utf8Length(tokens[i]);
      ends[i] = pos;
      pos += 1; // separating space
    }
    if (pos - 1 !== written) {
      // Should not happen; bail rather than hash garbage.
      return;
    }

    for (let i = 0; i < tokens.length; i++) {
      this.hashInto(this.scratch, starts[i], ends[i], N_CHAR, N_WORD);
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      this.hashInto(this.scratch, starts[i], ends[i + 1], N_CHAR, N_WORD);
    }
  }
}

/** UTF-8 byte length of `s`, without encoding it. */
function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The 17 structural features, in `config.json`'s `structural_names` order.
 * Computed on the *original* content — not the preprocessed text — so that
 * casing, invisible characters, and full URLs are all still observable.
 */
function addStructural(
  out: Float64Array,
  raw: string,
  tags: string[][],
  cpLen: number,
): void {
  URL_PATTERN.lastIndex = 0;
  let urlCount = 0;
  const domains = new Set<string>();
  for (const m of raw.matchAll(URL_PATTERN)) {
    urlCount++;
    domains.add(m[1].toLowerCase());
  }

  let tagP = 0;
  let tagE = 0;
  let tagT = 0;
  let tagOther = 0;
  for (const tag of tags) {
    if (tag.length === 0) continue;
    switch (tag[0]) {
      case "p":
        tagP++;
        break;
      case "e":
        tagE++;
        break;
      case "t":
        tagT++;
        break;
      default:
        tagOther++;
    }
  }

  const emojiCount = countMatches(EMOJI_PATTERN, raw);
  const letters = countMatches(UNICODE_LETTER, raw);
  const uppers = countMatches(UNICODE_UPPER, raw);

  out[0] += cpLen;
  out[1] += countMatches(NONWS_TOKEN, raw);
  out[2] += urlCount;
  out[3] += domains.size;
  out[4] += countMatches(MENTION_PATTERN, raw);
  out[5] += countMatches(HASHTAG_PATTERN, raw);
  out[6] += tagP;
  out[7] += tagE;
  out[8] += tagT;
  out[9] += tagOther;
  out[10] += emojiCount;
  out[11] += cpLen > 0 ? emojiCount / cpLen : 0;
  out[12] += countInvisibleChars(raw);
  out[13] += letters > 0 ? uppers / letters : 0;
  out[14] += cpLen > 0 ? countMatches(UNICODE_DIGIT, raw) / cpLen : 0;
  out[15] += cpLen > 0 ? countMatches(UNICODE_PUNCT, raw) / cpLen : 0;
  // out[16] is dup_body_bucket, which the reference implementation zeroes
  // for portability. Left at 0 to stay in parity with it.
}

/** Population (not sample) standard deviation. */
function populationStdDev(values: readonly number[]): number {
  const n = values.length;
  if (n <= 1) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let variance = 0;
  for (const v of values) variance += (v - mean) * (v - mean);
  return Math.sqrt(variance / n);
}
