import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";
import { isExpired } from "./expiration.ts";

/** Build a minimal NostrEvent for testing. */
function mkEvent(tags: string[][] = []): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey: "1".repeat(64),
    created_at: 0,
    kind: 1,
    tags,
    content: "",
    sig: "2".repeat(128),
  };
}

describe("isExpired", () => {
  const now = 1_788_198_037;

  it("is false without an expiration tag", () => {
    assert.equal(isExpired(mkEvent(), now), false);
    assert.equal(isExpired(mkEvent([["t", "nostr"]]), now), false);
  });

  it("is false for a future expiration", () => {
    assert.equal(
      isExpired(mkEvent([["expiration", String(now + 1)]]), now),
      false,
    );
  });

  it("is true for a past expiration", () => {
    assert.equal(
      isExpired(mkEvent([["expiration", String(now - 1)]]), now),
      true,
    );
  });

  it("treats the expiration second itself as expired", () => {
    assert.equal(isExpired(mkEvent([["expiration", String(now)]]), now), true);
  });

  it("ignores a malformed or valueless expiration tag", () => {
    // A tag we cannot read is not grounds to hide an event forever.
    assert.equal(isExpired(mkEvent([["expiration", "soon"]]), now), false);
    assert.equal(isExpired(mkEvent([["expiration"]]), now), false);
    assert.equal(isExpired(mkEvent([["expiration", ""]]), now), false);
  });

  it("reads the first expiration tag when an event carries several", () => {
    assert.equal(
      isExpired(
        mkEvent([
          ["expiration", String(now - 1)],
          ["expiration", String(now + 1000)],
        ]),
        now,
      ),
      true,
    );
  });

  it("defaults to the current clock", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const future = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(isExpired(mkEvent([["expiration", String(past)]])), true);
    assert.equal(isExpired(mkEvent([["expiration", String(future)]])), false);
  });
});
