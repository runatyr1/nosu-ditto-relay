/**
 * Tests for the analyzer's spam-scoring step.
 *
 * The classifier itself is verified against the model's own fixtures in
 * nspam/nspam.test.ts. What matters here is the *gating*: the model is
 * trained on kind 1 replies and nothing else, so scoring anything else would
 * produce a confident-looking number with no meaning behind it.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

import { type Analyzer, createAnalyzer } from "./analyze.ts";
import { createSpamClassifier } from "./nspam/index.ts";

const sk = generateSecretKey();

function sign(
  kind: number,
  content: string,
  tags: string[][] = [],
): ReturnType<typeof finalizeEvent> {
  return finalizeEvent(
    { kind, content, tags, created_at: Math.floor(Date.now() / 1000) },
    sk,
  );
}

const REPLY_TAG = ["e", "a".repeat(64), "", "root"];
const P_TAG = ["p", "b".repeat(64)];

describe("analyze: spam scoring", () => {
  let analyzeWithSpam: Analyzer;
  let analyzeWithoutSpam: Analyzer;

  before(async () => {
    const classifier = await createSpamClassifier();
    analyzeWithSpam = await createAnalyzer({
      spam: { classifier, threshold: 0.99 },
    });
    analyzeWithoutSpam = await createAnalyzer();
  });

  it("scores a kind 1 reply", () => {
    const result = analyzeWithSpam(
      sign(1, "sure, that makes sense", [REPLY_TAG]),
    );
    assert.equal(typeof result.spam_score, "number");
    assert.ok(result.spam_score !== undefined);
    assert.ok(result.spam_score >= 0 && result.spam_score <= 1);
  });

  it("does not score a kind 1 root note", () => {
    const result = analyzeWithSpam(sign(1, "good morning nostr", [P_TAG]));
    assert.equal(result.spam_score, undefined);
  });

  it("does not score a kind 1 quote", () => {
    // The reference client scores replies only and skips quotes, so a note
    // carrying both `e` and `q` is out of scope.
    const result = analyzeWithSpam(
      sign(1, "look at this", [REPLY_TAG, ["q", "c".repeat(64)]]),
    );
    assert.equal(result.spam_score, undefined);
  });

  it("scores a kind 1111 comment (NIP-22)", () => {
    const result = analyzeWithSpam(
      sign(1111, "great post, thanks for writing it", [
        ["E", "a".repeat(64)],
        ["K", "1"],
        ["e", "a".repeat(64)],
        ["k", "1"],
      ]),
    );
    assert.equal(typeof result.spam_score, "number");
  });

  it("scores a kind 1111 comment scoped to a URL", () => {
    // No `e` tag anywhere — the root scope is an external identifier.
    const result = analyzeWithSpam(
      sign(1111, "nice article!", [
        ["I", "https://example.com/articles/1"],
        ["K", "web"],
        ["i", "https://example.com/articles/1"],
        ["k", "web"],
      ]),
    );
    assert.equal(typeof result.spam_score, "number");
  });

  it("does not score other kinds, even with an e tag", () => {
    for (const kind of [0, 6, 7, 1110, 1112, 30023]) {
      const result = analyzeWithSpam(sign(kind, "+", [REPLY_TAG]));
      assert.equal(
        result.spam_score,
        undefined,
        `kind ${kind} should not be scored`,
      );
    }
  });

  it("does not score when no classifier is configured", () => {
    const result = analyzeWithoutSpam(sign(1, "sure, that works", [REPLY_TAG]));
    assert.equal(result.spam_score, undefined);
  });

  it("does not score under verifyOnly", () => {
    // AUTH events take this path; they must not pay for analysis at all.
    const result = analyzeWithSpam(sign(1, "sure, that works", [REPLY_TAG]), {
      verifyOnly: true,
    });
    assert.equal(result.verified, true);
    assert.equal(result.spam_score, undefined);
    assert.equal(result.search_text, undefined);
  });

  it("does not score an event that fails verification", () => {
    const event = sign(1, "sure, that works", [REPLY_TAG]);
    const forged = { ...event, content: "buy my coin" };
    const result = analyzeWithSpam(forged);
    assert.equal(result.verified, false);
    assert.equal(result.spam_score, undefined);
  });

  it("flags an obvious templated reply above the default threshold", () => {
    // Sanity check that the wiring reaches a real model, not a stub.
    const result = analyzeWithSpam(
      sign(
        1,
        "GM nostr:npub1tdpalck3l0sag9mp2styjxtfgpq2d9j395kugxvn5yk457uaechqldpvp9 pura vida! 💜",
        [REPLY_TAG, P_TAG],
      ),
    );
    assert.ok(result.spam_score !== undefined);
    assert.ok(
      result.spam_score > 0.5,
      `expected a high score, got ${result.spam_score}`,
    );
  });
});
