/**
 * nspam — on-device Nostr reply-spam classifier.
 *
 * Model: barrydeen/nspam v2.4 (MIT), a LightGBM ensemble over hashed
 * character and word n-grams plus structural features. Ported from the
 * Kotlin reference implementation in barrydeen/wisp (MIT); see the
 * individual modules for the two places our port deliberately differs from
 * it, and `*.test.ts` for the fixture-level verification.
 *
 * Scope, per the model card: **reply** notes. It is not trained on feed posts
 * and will produce meaningless numbers for them, so callers must gate on
 * {@link isScorable}.
 */

import { FeatureExtractor, type NoteInput } from "./features.ts";
import { LightGbmModel } from "./lightgbm.ts";

export type { NoteInput } from "./features.ts";
export { LightGbmModel } from "./lightgbm.ts";

/** Path to the packed model shipped with the relay. */
export const MODEL_PATH = new URL("./model.bin", import.meta.url).pathname;

/**
 * The model scores author bundles of up to 10 recent replies; anything past
 * that is dropped newest-first, matching the reference implementation.
 */
const MAX_GROUP_SIZE = 10;

/**
 * Maximum note content, in code points, fed to the model.
 *
 * Scoring is linear in content length — roughly 0.6ms per KB, since the
 * char_wb block hashes three n-grams per character. `max_message_length` is
 * 4 MB, so an uncapped 4 MB reply costs ~2.4 *seconds* of blocking CPU on a
 * protocol worker. That is a trivial denial of service, and the cap is what
 * makes this safe to run on the ingest path.
 *
 * 2048 is well clear of real traffic: in a sample of 612 consecutive replies
 * from a production relay the 99th percentile was 1001 code points and the
 * longest was 1937, so nothing was truncated and no score moved. It bounds
 * the adversarial case at roughly 1.1ms per note.
 *
 * This mirrors `MAX_DETECT_INPUT_LENGTH` in analyze.ts, which caps the input
 * to tinyld and the sentiment analyzer for the same reason.
 */
export const MAX_SCORED_CONTENT = 2048;

/** Truncate `content` to at most {@link MAX_SCORED_CONTENT} code points. */
function capContent(content: string): string {
  // A string can only exceed the cap in code points if it exceeds it in
  // UTF-16 units, so most notes return here untouched.
  if (content.length <= MAX_SCORED_CONTENT) return content;
  // Every code point is one or two UTF-16 units, so the first `2 * cap` units
  // contain at least `cap` code points. Slice first — spreading a 4 MB string
  // into a code-point array is itself linear in the full length, which is
  // exactly the cost the cap exists to avoid.
  const head = content.slice(0, MAX_SCORED_CONTENT * 2);
  const points = [...head];
  if (points.length <= MAX_SCORED_CONTENT) return head;
  return points.slice(0, MAX_SCORED_CONTENT).join("");
}

/** Minimal event shape needed to decide scorability. */
interface EventLike {
  kind: number;
  tags: string[][];
}

/**
 * Whether the model applies to this event.
 *
 * Two shapes qualify, and they need different rules because the kinds carry
 * different amounts of information:
 *
 *  - **Kind 1** is ambiguous — the same kind covers root notes and replies —
 *    so it must carry an `e` tag to count as a reply, and a `q` tag
 *    disqualifies it. A kind 1 with `q` is a quote-post, a different shape
 *    from the replies the model was trained on. This mirrors the gating in
 *    the reference client.
 *
 *  - **Kind 1111** (NIP-22) is a comment by definition; the kind *is* the
 *    reply marker. There is no `e` tag to require: the root scope may be an
 *    address (`A`/`a`) or an external identifier (`I`/`i` — a URL, a podcast
 *    GUID, a geohash) rather than an event id, so demanding one would skip
 *    most comments on articles and web pages. And per NIP-22 a `q` tag on a
 *    comment is a NIP-21 citation *within* the comment, not a quote-post, so
 *    it does not disqualify — treating it as such would also hand spammers a
 *    one-tag bypass.
 *
 * Note the model is trained on kind 1 replies only, so kind 1111 is an
 * extrapolation. The content shape is the same (short plaintext replying to
 * something), but NIP-22's uppercase root-scope tags land in the model's
 * `tag_other_count` feature at levels it never saw in training.
 */
export function isScorable(event: EventLike): boolean {
  if (event.kind === 1111) return true;
  if (event.kind !== 1) return false;

  let hasE = false;
  for (const tag of event.tags) {
    if (tag.length < 2) continue;
    if (tag[0] === "q") return false;
    if (tag[0] === "e") hasE = true;
  }
  return hasE;
}

/**
 * Both forms of the model's output.
 *
 * They are not interchangeable, and which one to use is not a matter of
 * taste. The model's isotonic calibration table has only four knots —
 * `x = [2.7e-9, 7.3e-4, 0.0896, 1.0]`, `y = [0, 0, 1, 1]` — so `calibrated`
 * clips to exactly 0 below raw 0.00073 and exactly 1 above raw 0.0896. On
 * real relay traffic that saturates 91.5% of notes to one endpoint, leaving
 * ~54 distinct values across 612 notes and no usable range to threshold
 * against.
 *
 * `raw` keeps the ordering the trees actually produce (251 distinct values
 * over the same sample), so it is what the relay stores and thresholds.
 * `calibrated` is what the model card documents and what the shipped parity
 * fixtures assert, so it stays available and tested.
 */
export interface SpamScore {
  /** Sigmoid of the raw tree margin. Continuous; use this for thresholds. */
  raw: number;
  /** `raw` run through the isotonic knots. Effectively three-state. */
  calibrated: number;
}

/**
 * A loaded classifier.
 *
 * Holds a reusable feature buffer, so it is stateful and not reentrant — one
 * instance per thread, and don't interleave calls to {@link score}.
 */
export class NSpamClassifier {
  private readonly extractor = new FeatureExtractor();

  constructor(private readonly model: LightGbmModel) {}

  /**
   * Probability that the author of these notes is a reply-spammer, or
   * `undefined` for an empty group. See {@link SpamScore} for which of the
   * two returned numbers to use.
   *
   * A single note is a valid group — `group_sizes_trained` in the model
   * config includes 1 — but it is the model's weakest configuration.
   *
   * Note content is truncated to {@link MAX_SCORED_CONTENT} code points; see
   * that constant for why the bound is not optional.
   */
  score(notes: readonly NoteInput[]): SpamScore | undefined {
    if (notes.length === 0) return undefined;
    const group =
      notes.length > MAX_GROUP_SIZE
        ? [...notes]
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, MAX_GROUP_SIZE)
        : notes;
    const capped = group.map((note) =>
      note.content.length <= MAX_SCORED_CONTENT
        ? note
        : { ...note, content: capContent(note.content) },
    );
    const features = this.extractor.extract(capped);
    const raw = this.model.rawScore(features);
    const calibrated = this.model.calibrate(raw);
    this.extractor.reset();
    return { raw, calibrated };
  }
}

/** Load the packed model from `path` and return a ready classifier. */
export async function createSpamClassifier(
  path: string = MODEL_PATH,
): Promise<NSpamClassifier> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  const classifier = new NSpamClassifier(LightGbmModel.unpack(bytes));
  // Warm the JIT and fault the model pages in, so the first real event does
  // not pay for it.
  classifier.score([
    { content: "warmup text for spam classification", tags: [], created_at: 0 },
  ]);
  return classifier;
}
