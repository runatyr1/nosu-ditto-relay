import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";

import { DEFAULT_NSFW_HASHTAGS, detectNsfw } from "./nsfw.ts";

function makeEvent(tags: string[][]): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1700000000,
    kind: 1,
    tags,
    content: "hello",
    sig: "c".repeat(128),
  };
}

describe("detectNsfw", () => {
  it("flags an event with media and an NSFW hashtag", () => {
    const event = makeEvent([["t", "nsfw"]]);
    assert.equal(detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS), true);
  });

  it("matches hashtags case-insensitively", () => {
    const event = makeEvent([["t", "NSFW"]]);
    assert.equal(detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS), true);
  });

  it("does not flag an NSFW hashtag without media", () => {
    const event = makeEvent([["t", "nsfw"]]);
    assert.equal(detectNsfw(event, false, DEFAULT_NSFW_HASHTAGS), false);
    assert.equal(detectNsfw(event, undefined, DEFAULT_NSFW_HASHTAGS), false);
  });

  it("does not flag media without an NSFW hashtag", () => {
    const event = makeEvent([["t", "cats"]]);
    assert.equal(detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS), false);
  });

  it("ignores NSFW terms in non-t tags", () => {
    const event = makeEvent([["subject", "nsfw"]]);
    assert.equal(detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS), false);
  });

  it("ignores bare t tags with no value", () => {
    const event = makeEvent([["t"]]);
    assert.equal(detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS), false);
  });

  it("returns false when the hashtag set is empty (disabled)", () => {
    const event = makeEvent([["t", "nsfw"]]);
    assert.equal(detectNsfw(event, true, new Set()), false);
  });

  it("flags the other adult hashtags in the default set", () => {
    for (const tag of ["porno", "hentai", "loli", "milf", "onlyfans"]) {
      const event = makeEvent([["t", tag]]);
      assert.equal(
        detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS),
        true,
        `expected #${tag} to be NSFW`,
      );
    }
  });

  it("does not flag hashtags with common non-adult usage", () => {
    for (const tag of [
      "girls",
      "teen",
      "teens",
      "fuck",
      "femboy",
      "dick",
      "ass",
      "butt",
      "sexy",
    ]) {
      const event = makeEvent([["t", tag]]);
      assert.equal(
        detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS),
        false,
        `expected #${tag} not to be NSFW`,
      );
    }
  });

  it("honors a custom hashtag set", () => {
    const event = makeEvent([["t", "lewd"]]);
    assert.equal(detectNsfw(event, true, DEFAULT_NSFW_HASHTAGS), false);
    assert.equal(detectNsfw(event, true, new Set(["lewd"])), true);
  });
});
