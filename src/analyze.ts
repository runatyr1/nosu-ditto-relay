/**
 * Nostr event analysis: signature verification (via nostr-wasm), search text
 * extraction, language detection (tinyld), sentiment analysis, and media
 * detection. Short-circuits if verification fails.
 *
 * This module is thread-agnostic: `createAnalyzer()` returns a synchronous
 * analyze function that runs wherever it is called. Protocol workers call it
 * inline so an EVENT never needs an extra thread hop.
 */

import type { NostrEvent } from "nostr-tools";
import { initNostrWasm } from "nostr-wasm";
import Sentiment from "sentiment";
import { detect as detectLanguage } from "tinyld";

import { buildAutocompleteText } from "./autocomplete-text.ts";
import { detectMedia } from "./media.ts";
import {
  relaySpamClassifiedCounter,
  relaySpamScoreHistogram,
} from "./metrics.ts";
import { DEFAULT_NSFW_HASHTAGS, detectNsfw } from "./nsfw.ts";
import { isScorable, type NSpamClassifier } from "./nspam/index.ts";
import { buildSearchText } from "./search-text.ts";

/** Result of analyzing a Nostr event. */
export interface AnalyzeResult {
  verified: boolean;
  search_text?: string;
  autocomplete_text?: string;
  language?: string;
  sentiment?: string;
  media?: boolean;
  video?: boolean;
  nsfw?: boolean;
  /**
   * Raw nspam score for kind 1 replies and kind 1111 comments (see
   * nspam/index.ts). Absent for every other event — the model applies to
   * replies only, so "absent" means "not scored", never "not spam".
   */
  spam_score?: number;
}

/** Synchronous event analyzer produced by {@link createAnalyzer}. */
export type Analyzer = (
  event: NostrEvent,
  opts?: { verifyOnly?: boolean },
) => AnalyzeResult;

/** Minimum text length (in characters) required to attempt language detection. */
const MIN_LANGUAGE_DETECT_LENGTH = 10;

/** Minimum absolute `comparative` score to classify as positive or negative. */
const SENTIMENT_THRESHOLD = 0.1;

/**
 * Maximum characters of search text passed to tinyld / sentiment.
 *
 * Both libraries scale with input length but neither needs the full 8 KB of
 * indexed search_text to make a confident call — a few hundred characters is
 * usually plenty for language ID and sentiment scoring. Capping the input
 * keeps long-form content (kind 30023) from dominating worker CPU.
 */
const MAX_DETECT_INPUT_LENGTH = 1024;

/** NIP-30 custom emoji shortcodes like `:soapbox:`. */
const CUSTOM_EMOJI_RE = /^:[\w-]+:$/;

/**
 * Hardcoded sentiment for common emoji reactions. Lets us skip the
 * sentiment-library call (which tokenizes and looks up every code point in
 * the AFINN lexicon) for the overwhelming majority of kind 7 reactions on
 * Nostr.
 *
 * The set was chosen from a 500k-event sample of real kind 7 reactions on
 * the production relay. After stripping variation-selector-16 and skin-tone
 * modifiers, the top ~100 entries here cover roughly 95% of emoji reactions
 * (which are themselves only ~12% of all kind 7 events — the rest are `+`,
 * `-`, empty, or NIP-30 custom shortcodes that hit existing fast paths).
 *
 * Normalization done before lookup (see `normalizeEmoji`):
 *   - strip U+FE0F (variation selector-16), so `❤` and `❤️` match
 *   - strip U+1F3FB..U+1F3FF (skin-tone modifiers), so `👍🏼` matches `👍`
 *
 * ZWJ-joined sequences (e.g. `👨‍👩‍👧`) are NOT stripped and fall through
 * to the library, except for the two common reactions explicitly listed
 * (`❤️‍🔥`, `🤷‍♂️`).
 *
 * Sentiment classifications reflect typical Nostr usage, which sometimes
 * diverges from a generic emoji sentiment list — e.g. 🚀, 🦅, 🦞, ₿, ⚡ are
 * community-positive flex emoji, and 🤡 is derisively negative.
 */
const EMOJI_SENTIMENT: Record<string, "positive" | "negative" | "neutral"> = {
  // Hearts — all colors / styles map to positive.
  "❤": "positive",
  "🧡": "positive",
  "💛": "positive",
  "💚": "positive",
  "💙": "positive",
  "💜": "positive",
  "🤍": "positive",
  "🤎": "positive",
  "🖤": "positive",
  "💖": "positive",
  "💕": "positive",
  "💗": "positive",
  "💘": "positive",
  "💝": "positive",
  "💞": "positive",
  "💟": "positive",
  "♥": "positive",
  // ZWJ sequence: heart-on-fire — common Nostr reaction, positive.
  "❤\u200d🔥": "positive",
  // Broken / negative hearts.
  "💔": "negative",
  // Positive gestures.
  "👍": "positive",
  "👏": "positive",
  "🙌": "positive",
  "🤝": "positive",
  "🫶": "positive",
  "🤙": "positive",
  "👌": "positive",
  "🤘": "positive",
  "✊": "positive",
  "👊": "positive",
  "🙏": "positive",
  "👋": "positive",
  "💪": "positive",
  "🤞": "positive",
  "🫡": "positive",
  "✍": "positive",
  // Neutral gestures (acknowledgement without sentiment).
  "☝": "neutral",
  "👉": "neutral",
  "👆": "neutral",
  "🤌": "neutral",
  // Negative gestures.
  "👎": "negative",
  "🖕": "negative",
  // Positive faces.
  "😀": "positive",
  "😃": "positive",
  "😄": "positive",
  "😁": "positive",
  "😆": "positive",
  "😊": "positive",
  "🙂": "positive",
  "😇": "positive",
  "🥰": "positive",
  "😍": "positive",
  "🤩": "positive",
  "🥳": "positive",
  "😎": "positive",
  "🤗": "positive",
  "😘": "positive",
  "😗": "positive",
  "😙": "positive",
  "😚": "positive",
  "🥲": "positive",
  "😋": "positive",
  "😌": "positive",
  "🤤": "positive",
  "😂": "positive",
  "🤣": "positive",
  "😺": "positive",
  "😸": "positive",
  "😹": "positive",
  "😻": "positive",
  // Negative faces.
  "😢": "negative",
  "😭": "negative",
  "😞": "negative",
  "😔": "negative",
  "😟": "negative",
  "😠": "negative",
  "😡": "negative",
  "🤬": "negative",
  "😤": "negative",
  "😩": "negative",
  "😫": "negative",
  "😨": "negative",
  "😰": "negative",
  "😱": "negative",
  "🤮": "negative",
  "🤢": "negative",
  "💀": "negative",
  "☠": "negative",
  "🥺": "negative",
  "😬": "negative",
  "💩": "negative",
  // Neutral / ambiguous faces — known-neutral to skip the analyzer.
  "🤔": "neutral",
  "🤷": "neutral",
  "🤷\u200d♂": "neutral",
  "🤷\u200d♀": "neutral",
  "😐": "neutral",
  "😑": "neutral",
  "😮": "neutral",
  "😯": "neutral",
  "😲": "neutral",
  "🤨": "neutral",
  "🧐": "neutral",
  "🙄": "neutral",
  "😏": "neutral",
  "😜": "neutral",
  "😈": "neutral",
  "🤯": "neutral",
  "🥴": "neutral",
  "😅": "neutral",
  "🤓": "neutral",
  "🤭": "neutral",
  "🫠": "neutral",
  "😳": "neutral",
  "👁": "neutral",
  // Positive symbols / objects.
  "✨": "positive",
  "🌟": "positive",
  "⭐": "positive",
  "🎉": "positive",
  "🎊": "positive",
  "🔥": "positive",
  "💯": "positive",
  "✅": "positive",
  "☑": "positive",
  "✔": "positive",
  "🚀": "positive",
  "🫂": "positive",
  "🥂": "positive",
  "🍻": "positive",
  "🌞": "positive",
  "☀": "positive",
  "🏆": "positive",
  "💥": "positive",
  "🍀": "positive",
  "👑": "positive",
  // Nostr-community-specific positive flex emoji.
  "🦅": "positive",
  "🦞": "positive",
  "₿": "positive",
  "⚡": "positive",
  // Neutral symbols.
  "👀": "neutral",
  "📜": "neutral",
  "☕": "neutral",
  "🎯": "neutral",
  "🍮": "neutral",
  "🫧": "neutral",
  "🐱": "neutral",
  "🐾": "neutral",
  // Negative symbols.
  "❌": "negative",
  "🚫": "negative",
  "⛔": "negative",
  "🤡": "negative",
};

/**
 * Variation-selector-16 — forces emoji presentation on dual-use codepoints
 * (e.g. ❤ U+2764 vs ❤️ U+2764 U+FE0F).
 */
const VS16 = "\uFE0F";

/**
 * Matches a single trailing skin-tone modifier (Fitzpatrick scale,
 * U+1F3FB through U+1F3FF) so 👍🏼 normalizes to 👍 for table lookup.
 */
const SKIN_TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;

/**
 * Normalize an emoji reaction for lookup in {@link EMOJI_SENTIMENT}:
 *   1. Strip any skin-tone modifier code points (anywhere in the string).
 *   2. Strip a trailing variation-selector-16, since the table is keyed on
 *      the text-presentation form.
 *
 * Cheap: at most one allocation when normalization is needed; common case
 * (no modifiers) is a single regex test that bails immediately.
 */
function normalizeEmoji(content: string): string {
  let s = content;
  // Skin-tone modifiers are rare; only walk the string when one is present.
  if (
    s.length > 1 &&
    s.charCodeAt(s.length - 1) >= 0xdc00 &&
    SKIN_TONE_RE.test(s)
  ) {
    s = s.replace(SKIN_TONE_RE, "");
    SKIN_TONE_RE.lastIndex = 0;
  }
  if (s.endsWith(VS16)) {
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * Kinds whose content is not useful natural-language text: encrypted payloads,
 * NIP-51 lists/sets, reposts, zap receipts, etc. For these we skip language
 * and sentiment detection entirely — the only "text" we'd have to feed in is
 * a handful of tag values (titles, summaries) which don't reliably carry
 * either signal and waste CPU on tinyld / sentiment dictionary lookups.
 *
 * Kind 7 (reactions) is intentionally NOT in this set — it gets its own
 * NIP-25 fast path below.
 */
const SKIP_LANG_SENT_KINDS = new Set([
  // Reposts (NIP-18)
  6, 16,
  // Encrypted content (NIP-04 / NIP-44 / NIP-59 / NIP-37)
  4, 13, 1059, 10013, 31234,
  // NIP-51 standard lists
  3, 10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10009, 10012,
  10015, 10020, 10030, 10050, 10101, 10102,
  // NIP-51 sets
  30000, 30002, 30003, 30004, 30005, 30006, 30007, 30015, 30030, 31924, 39089,
  39092,
  // Zap receipt
  9735,
]);

/**
 * Shared sentiment analyzer instance. Construction is cheap; the AFINN
 * lexicon is lazy-built on first use, which {@link createAnalyzer} warms up.
 */
const sentimentAnalyzer = new Sentiment();

/**
 * Detect the language of a Nostr event using its pre-computed search text.
 *
 * Returns an ISO 639-1 two-letter code, or `undefined` when the language
 * cannot be determined.
 */
function detectEventLanguage(searchText: string): string | undefined {
  if (searchText.length < MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const input =
    searchText.length > MAX_DETECT_INPUT_LENGTH
      ? searchText.slice(0, MAX_DETECT_INPUT_LENGTH)
      : searchText;

  const detected = detectLanguage(input);
  return detected || undefined; // tinyld returns "" when unsure
}

/**
 * Detect the sentiment of a Nostr event.
 *
 * Uses the pre-computed search text for most kinds. Kind 7 (reactions)
 * is handled specially per NIP-25: `"+"` or `""` maps to `"positive"`,
 * `"-"` maps to `"negative"`, and emoji reactions are looked up in a
 * hardcoded table of common emoji before falling back to the sentiment
 * library for the long tail.
 *
 * Returns `"positive"`, `"negative"`, `"neutral"`, or `undefined` when
 * sentiment cannot be determined.
 */
function detectEventSentiment(
  event: NostrEvent,
  searchText: string,
): string | undefined {
  // Kind 7 reactions get special handling (NIP-25).
  if (event.kind === 7) {
    const content = event.content;
    // "+" or empty string = like / upvote (NIP-25).
    if (content === "+" || content === "") return "positive";
    // "-" = dislike / downvote (NIP-25).
    if (content === "-") return "negative";
    // Custom emoji shortcodes have no intrinsic sentiment.
    if (CUSTOM_EMOJI_RE.test(content)) return undefined;
    // Fast path: hardcoded lookup for common emoji reactions. Normalize the
    // content first (strip skin-tone modifiers and trailing VS16) so that
    // `❤️`, `❤`, `👍🏼`, `👍`, etc. all hit the same entry.
    const mapped = EMOJI_SENTIMENT[normalizeEmoji(content)];
    if (mapped !== undefined) return mapped;
    // Long-tail emoji / multi-char reactions — let the sentiment library score them.
    const result = sentimentAnalyzer.analyze(content);
    if (result.comparative > SENTIMENT_THRESHOLD) return "positive";
    if (result.comparative < -SENTIMENT_THRESHOLD) return "negative";
    return "neutral";
  }

  // For all other kinds, analyze the search text.
  if (searchText.length < MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const input =
    searchText.length > MAX_DETECT_INPUT_LENGTH
      ? searchText.slice(0, MAX_DETECT_INPUT_LENGTH)
      : searchText;

  const result = sentimentAnalyzer.analyze(input);
  if (result.comparative > SENTIMENT_THRESHOLD) return "positive";
  if (result.comparative < -SENTIMENT_THRESHOLD) return "negative";
  return "neutral";
}

/**
 * Create a synchronous event analyzer.
 *
 * Performs the one-time expensive initialization up front: loads the
 * nostr-wasm verifier and warms up tinyld (n-gram tables) and the sentiment
 * analyzer (AFINN lexicon), so the first real event doesn't pay lazy-init
 * cost on whatever thread this runs on.
 */
export async function createAnalyzer(opts?: {
  /** Lowercase NSFW hashtag set (see nsfw.ts). Empty set disables. */
  nsfwHashtags?: ReadonlySet<string>;
  /**
   * Loaded nspam classifier and the threshold it is scored against. Omit to
   * skip spam scoring entirely — callers pass this only when
   * `SPAM_THRESHOLD` is non-zero.
   *
   * The threshold is used solely to label the metrics; the score itself is
   * stored raw and the filtering decision belongs to the storage layer.
   * Bundled with the classifier so the two cannot fall out of step.
   */
  spam?: { classifier: NSpamClassifier; threshold: number };
}): Promise<Analyzer> {
  const nsfwHashtags = opts?.nsfwHashtags ?? DEFAULT_NSFW_HASHTAGS;
  const spam = opts?.spam;
  const nw = await initNostrWasm();

  detectLanguage("warmup text for language detection");
  sentimentAnalyzer.analyze("warmup text for sentiment analysis");

  return function analyzeEvent(
    nostrEvent: NostrEvent,
    opts?: { verifyOnly?: boolean },
  ): AnalyzeResult {
    // Step 1: Verify signature
    let verified: boolean;
    try {
      nw.verifyEvent(nostrEvent);
      verified = true;
    } catch {
      verified = false;
    }

    // Build the result imperatively to avoid the per-event allocation churn
    // of conditional spreads (`...(x && { x })`), which create 3–4 throwaway
    // objects per event under firehose load.
    const out: AnalyzeResult = { verified };

    // Short-circuit if verification failed — don't waste time on analysis.
    // Also short-circuit if the caller only wants the verified bit.
    if (!verified || opts?.verifyOnly) {
      return out;
    }

    // Step 2: Build search text (used by language/sentiment detection below)
    const searchText = buildSearchText(nostrEvent);
    if (searchText) out.search_text = searchText;

    // Step 2b: Build autocomplete text (short name/title-shaped surface used
    // by the NIP-50 `autocomplete:true` extension token; see
    // src/autocomplete-text.ts).
    const autocompleteText = buildAutocompleteText(nostrEvent);
    if (autocompleteText) out.autocomplete_text = autocompleteText;

    // Step 3: Detect language and sentiment, but only for kinds whose content
    // is natural-language text. Encrypted payloads, NIP-51 lists, reposts,
    // and zap receipts get media detection only.
    const kind = nostrEvent.kind;
    if (!SKIP_LANG_SENT_KINDS.has(kind)) {
      const language = detectEventLanguage(searchText);
      if (language) out.language = language;
      const sentiment = detectEventSentiment(nostrEvent, searchText);
      if (sentiment) out.sentiment = sentiment;
    }

    // Step 4: Detect media (cheap, no kind restriction beyond what detectMedia does)
    const { media, video } = detectMedia(nostrEvent);
    if (media !== undefined) out.media = media;
    if (video !== undefined) out.video = video;

    // Step 5: NSFW classification — media attachment + NSFW hashtag
    // (see nsfw.ts). Queried by the NIP-50 `nsfw:false` extension.
    if (detectNsfw(nostrEvent, media, nsfwHashtags)) out.nsfw = true;

    // Step 6: nspam reply-spam score. Gated by `isScorable` to kind 1 replies
    // and kind 1111 comments — the reply-shaped kinds. Scored as a group of
    // one, which is a trained group size but the model's weakest; see
    // nspam/index.ts.
    if (spam && isScorable(nostrEvent)) {
      const score = spam.classifier.score([nostrEvent]);
      if (score) {
        out.spam_score = score.raw;
        relaySpamScoreHistogram.observe(score.raw);
        relaySpamClassifiedCounter.inc({
          spam: String(score.raw >= spam.threshold),
        });
      }
    }

    return out;
  };
}
