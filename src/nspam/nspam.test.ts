/**
 * Parity tests for the nspam port.
 *
 * Both fixture files ship with the model (barrydeen/nspam v2.4) and exist
 * precisely so ports can prove themselves:
 *
 *   - `hash_fixtures.jsonl` pins the vectorizer at the token level: the exact
 *     bucket index and sign each n-gram lands on. Tokens are fed to the
 *     vectorizer verbatim, without the preprocessing pipeline.
 *   - `parity_fixtures.jsonl` pins the whole pipeline: real Nostr events in,
 *     expected raw and calibrated scores out.
 *
 * If these fail, the port is wrong and nothing downstream of it means
 * anything.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  FeatureExtractor,
  N_CHAR,
  N_WORD,
  type NoteInput,
} from "./features.ts";
import { isScorable, NSpamClassifier } from "./index.ts";
import { LightGbmModel } from "./lightgbm.ts";
import { hash32 } from "./murmur3.ts";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);
const MODEL_PATH = new URL("./model.bin", import.meta.url);

/**
 * Mirrors `SPAM_THRESHOLD`'s default in config.ts. Duplicated rather than
 * imported so this file stays a test of the classifier alone.
 */
const DEFAULT_SPAM_THRESHOLD = 0.99;

function readJsonl<T>(name: string): T[] {
  const text = readFileSync(new URL(name, FIXTURE_DIR), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

interface Bucket {
  index: number;
  value: number;
}

interface HashFixture {
  token: string;
  word_buckets: Bucket[];
  char_wb_buckets: Bucket[];
}

interface ParityFixture {
  label: number;
  pubkey: string;
  notes: Array<{
    id: string;
    content: string;
    tags: string[][];
    created_at: number;
  }>;
  expected_raw_score: number;
  expected_calibrated_score: number;
}

/**
 * The fixtures list at most this many buckets per token — long tokens like
 * `http://example.com` produce 51 char n-grams but only the first 32 by index
 * are recorded. Compare against the same prefix rather than the whole block.
 */
const FIXTURE_BUCKET_CAP = 32;

/** Nonzero entries of `[start, start + length)`, sorted by index. */
function nonzero(
  vector: Float64Array,
  start: number,
  length: number,
): Bucket[] {
  const out: Bucket[] = [];
  for (let i = 0; i < length; i++) {
    const value = vector[start + i];
    if (value !== 0) out.push({ index: i, value });
  }
  return out;
}

describe("murmur3", () => {
  it("matches the canonical x86_32 test vectors", () => {
    const enc = new TextEncoder();
    assert.equal(hash32(enc.encode("")), 0);
    assert.equal(hash32(enc.encode(""), 1), 0x514e28b7 | 0);
    assert.equal(hash32(enc.encode("hello")), hash32(enc.encode("hello")));
  });

  it("does not overflow on 32-bit multiplies", () => {
    // A plain `*` here would exceed 2^53 and silently truncate; every byte
    // length exercises a different tail path.
    const enc = new TextEncoder();
    for (const s of ["a", "ab", "abc", "abcd", "abcde", "abcdefgh"]) {
      const h = hash32(enc.encode(s));
      assert.ok(Number.isInteger(h) && h >= -2147483648 && h <= 2147483647);
    }
  });
});

describe("vectorizer (hash_fixtures.jsonl)", () => {
  const fixtures = readJsonl<HashFixture>("hash_fixtures.jsonl");

  it("has fixtures", () => {
    assert.ok(fixtures.length > 0);
  });

  for (const fixture of fixtures) {
    it(`hashes ${JSON.stringify(fixture.token)} into the expected char_wb buckets`, () => {
      const extractor = new FeatureExtractor();
      extractor.reset();
      extractor.hashCharWbNgrams(fixture.token);
      assert.deepEqual(
        nonzero(extractor.vector, 0, N_CHAR).slice(0, FIXTURE_BUCKET_CAP),
        fixture.char_wb_buckets,
      );
    });

    it(`hashes ${JSON.stringify(fixture.token)} into the expected word buckets`, () => {
      const extractor = new FeatureExtractor();
      extractor.reset();
      extractor.hashWordNgrams(fixture.token);
      assert.deepEqual(
        nonzero(extractor.vector, N_CHAR, N_WORD).slice(0, FIXTURE_BUCKET_CAP),
        fixture.word_buckets,
      );
    });
  }
});

describe("classifier (parity_fixtures.jsonl)", () => {
  const fixtures = readJsonl<ParityFixture>("parity_fixtures.jsonl");
  const model = LightGbmModel.unpack(readFileSync(MODEL_PATH));
  const classifier = new NSpamClassifier(model);

  it("loads 500 trees from the packed model", () => {
    assert.equal(model.numTrees, 500);
  });

  it("has fixtures", () => {
    assert.ok(fixtures.length >= 50);
  });

  for (const [i, fixture] of fixtures.entries()) {
    it(`reproduces fixture ${i} (${fixture.notes.length} note(s), label ${fixture.label})`, () => {
      const notes: NoteInput[] = fixture.notes.map((n) => ({
        content: n.content,
        tags: n.tags,
        created_at: n.created_at,
      }));
      const score = classifier.score(notes);
      assert.ok(score !== undefined);
      assert.ok(
        Math.abs(score.calibrated - fixture.expected_calibrated_score) < 1e-4,
        `calibrated ${score.calibrated} != expected ${fixture.expected_calibrated_score}`,
      );
      assert.ok(
        Math.abs(score.raw - fixture.expected_raw_score) < 1e-6,
        `raw ${score.raw} != expected ${fixture.expected_raw_score}`,
      );
    });
  }

  it("reproduces every raw score", () => {
    const extractor = new FeatureExtractor();
    for (const [i, fixture] of fixtures.entries()) {
      const features = extractor.extract(fixture.notes);
      const raw = 1 / (1 + Math.exp(-model.rawMargin(features)));
      extractor.reset();
      assert.ok(
        Math.abs(raw - fixture.expected_raw_score) < 1e-6,
        `fixture ${i}: raw ${raw} != expected ${fixture.expected_raw_score}`,
      );
    }
  });

  it("separates the labelled classes", () => {
    // Not a quality metric — the fixture set is far too small — just a guard
    // that the port is not returning a constant. Asserted against the gap
    // between the classes rather than a fixed threshold, so retuning
    // SPAM_THRESHOLD does not silently invalidate this.
    const spam: number[] = [];
    const ham: number[] = [];
    for (const fixture of fixtures) {
      const score = classifier.score(fixture.notes);
      assert.ok(score !== undefined);
      (fixture.label === 1 ? spam : ham).push(score.raw);
    }
    assert.ok(spam.length > 0 && ham.length > 0);

    const hamMax = Math.max(...ham);
    assert.ok(hamMax < 0.01, `highest ham score was ${hamMax}`);
    // One spam author the model misses outright — its own false negative,
    // reproduced faithfully.
    assert.ok(
      spam.filter((s) => s > hamMax).length >= spam.length - 1,
      "at most one spam author should score below the ham ceiling",
    );
  });

  it("flags no legitimate author at the relay's default threshold", () => {
    for (const fixture of fixtures) {
      if (fixture.label !== 0) continue;
      const score = classifier.score(fixture.notes);
      assert.ok(score !== undefined);
      assert.ok(
        score.raw < DEFAULT_SPAM_THRESHOLD,
        `ham fixture scored ${score.raw}, at or above the default threshold`,
      );
    }
  });

  it("saturates the calibrated score, which is why raw is what we store", () => {
    // The calibration table has four knots and clips at both ends, so the
    // calibrated score carries far less orderable information than raw. If a
    // future model version changes that, this test should be revisited along
    // with the choice to threshold on raw.
    const distinct = (xs: number[]) =>
      new Set(xs.map((x) => x.toFixed(6))).size;
    const scores = fixtures.map((f) => {
      const s = classifier.score(f.notes);
      assert.ok(s !== undefined);
      return s;
    });
    const saturated = scores.filter(
      (s) => s.calibrated === 0 || s.calibrated === 1,
    ).length;
    assert.ok(
      saturated / scores.length > 0.8,
      "expected the calibrated score to clip to 0/1 for most inputs",
    );
    assert.ok(
      distinct(scores.map((s) => s.raw)) >
        distinct(scores.map((s) => s.calibrated)),
      "raw should be strictly more informative than calibrated",
    );
  });

  it("returns undefined for an empty group", () => {
    assert.equal(classifier.score([]), undefined);
  });

  it("caps note content so cost stays bounded", () => {
    // Scoring is linear in content length and `max_message_length` is 4 MB,
    // so without the cap a single event could block a worker for seconds.
    const note = (n: number): NoteInput => ({
      content: "spam free bitcoin now check my profile ".repeat(n),
      tags: [["e", "a".repeat(64)]],
      created_at: 0,
    });

    const start = performance.now();
    const huge = classifier.score([note(110_000)]); // ~4 MB of content
    const elapsed = performance.now() - start;

    assert.ok(huge !== undefined);
    assert.ok(
      elapsed < 100,
      `scoring a 4 MB note took ${elapsed.toFixed(0)}ms; the content cap is not being applied`,
    );

    // Truncation is what makes that bound hold, so anything past the cap must
    // not change the score.
    assert.deepEqual(
      classifier.score([note(200)]),
      classifier.score([note(400)]),
    );
  });
});

describe("model validation", () => {
  const packed = readFileSync(MODEL_PATH);

  it("accepts the shipped model", () => {
    assert.equal(LightGbmModel.unpack(packed).numTrees, 500);
  });

  it("rejects a cyclic tree", () => {
    // rawMargin walks `while (node >= 0)` with no iteration bound, so a model
    // whose children cycle would hang the worker rather than return a bad
    // answer. Point tree 0's root at itself.
    const corrupt = Uint8Array.from(packed);
    const view = new DataView(corrupt.buffer);
    const numTrees = view.getUint32(8, true);
    const numNodes = view.getUint32(12, true);
    // Header, then treeNodeOffsets and treeLeafOffsets, then splitFeature,
    // then leftChild — whose first entry is tree 0's root left child.
    const leftChildStart = 32 + (numTrees + 1) * 2 * 4 + numNodes * 4;
    view.setInt32(leftChildStart, 0, true);

    assert.throws(() => LightGbmModel.unpack(corrupt), /cyclic/);
  });

  it("rejects an out-of-range child pointer", () => {
    const corrupt = Uint8Array.from(packed);
    const view = new DataView(corrupt.buffer);
    const numTrees = view.getUint32(8, true);
    const numNodes = view.getUint32(12, true);
    const leftChildStart = 32 + (numTrees + 1) * 2 * 4 + numNodes * 4;
    view.setInt32(leftChildStart, 1 << 30, true);

    assert.throws(() => LightGbmModel.unpack(corrupt), /out-of-range/);
  });

  it("rejects a file that is not a packed model", () => {
    assert.throws(() => LightGbmModel.unpack(new Uint8Array(64)), /bad magic/);
  });
});

describe("isScorable", () => {
  const e = (id: string) => ["e", id];
  const p = (id: string) => ["p", id];

  it("accepts a kind 1 reply", () => {
    assert.equal(isScorable({ kind: 1, tags: [e("abc"), p("def")] }), true);
  });

  it("rejects a kind 1 root note", () => {
    assert.equal(isScorable({ kind: 1, tags: [["t", "nostr"]] }), false);
  });

  it("rejects a kind 1 quote", () => {
    // A kind 1 carrying `q` is a quote-post, a different shape from the
    // replies the model was trained on.
    assert.equal(
      isScorable({ kind: 1, tags: [e("abc"), ["q", "xyz"]] }),
      false,
    );
  });

  it("accepts a kind 1111 comment on an event", () => {
    assert.equal(
      isScorable({
        kind: 1111,
        tags: [["E", "abc"], ["K", "1063"], e("abc"), ["k", "1063"]],
      }),
      true,
    );
  });

  it("accepts a kind 1111 comment with no e tag", () => {
    // NIP-22 scopes comments to an address or an external identifier just as
    // often as to an event id. Requiring an `e` tag would skip every comment
    // on an article, a URL, or a podcast episode.
    for (const tags of [
      [
        ["A", "30023:abc:slug"],
        ["K", "30023"],
        ["a", "30023:abc:slug"],
      ],
      [
        ["I", "https://example.com/post"],
        ["K", "web"],
      ],
      [
        ["I", "podcast:item:guid:abc"],
        ["K", "podcast:item:guid"],
      ],
    ]) {
      assert.equal(isScorable({ kind: 1111, tags }), true);
    }
  });

  it("accepts a kind 1111 comment carrying a q tag", () => {
    // On a comment, `q` is a NIP-21 citation inside the text — not a
    // quote-post. Excluding it would also be a one-tag bypass for spammers.
    assert.equal(
      isScorable({
        kind: 1111,
        tags: [
          ["E", "abc"],
          ["q", "xyz"],
        ],
      }),
      true,
    );
  });

  it("rejects other kinds", () => {
    for (const kind of [0, 3, 6, 7, 1059, 1110, 1112, 30023]) {
      assert.equal(
        isScorable({ kind, tags: [e("abc")] }),
        false,
        `kind ${kind} should not be scorable`,
      );
    }
  });

  it("ignores malformed tags", () => {
    assert.equal(isScorable({ kind: 1, tags: [[], ["e"]] }), false);
  });
});
