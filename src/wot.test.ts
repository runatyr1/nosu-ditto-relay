import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent, NostrFilter, NStore } from "@nostrify/nostrify";

import { Wot } from "./wot.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

/** Build a kind 3 contact list for `author` following `follows`. */
function contactList(author: string, follows: string[]): NostrEvent {
  return {
    id: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
    pubkey: author,
    created_at: Math.floor(Date.now() / 1000),
    kind: 3,
    tags: follows.map((pk) => ["p", pk]),
    content: "",
    sig: "0".repeat(128),
  };
}

/**
 * Mock NStore serving kind 3 events by author and recording the filters
 * it was queried with.
 */
function createMockRelay(lists: NostrEvent[]): NStore & {
  queries: NostrFilter[][];
} {
  const queries: NostrFilter[][] = [];
  return {
    queries,
    query: async (filters: NostrFilter[]) => {
      queries.push(filters);
      const authors = filters[0]?.authors ?? [];
      return lists.filter((e) => authors.includes(e.pubkey));
    },
    event: async () => {},
  } as unknown as NStore & { queries: NostrFilter[][] };
}

describe("Wot", () => {
  it("returns undefined before the first refresh", () => {
    const wot = new Wot({ relay: createMockRelay([]), seeds: new Set([A]) });
    assert.equal(wot.trusted(), undefined);
  });

  it("expands seeds two follow-hops through kind 3 lists", async () => {
    // A follows B and C; B follows D; D follows E (a third hop, excluded).
    const relay = createMockRelay([
      contactList(A, [B, C]),
      contactList(B, [D]),
      contactList(D, [E]),
    ]);
    const wot = new Wot({ relay, seeds: new Set([A]) });

    await wot.refresh();

    const trusted = wot.trusted();
    assert.ok(trusted);
    assert.deepEqual(trusted, new Set([A, B, C, D]));
    assert.ok(!trusted.has(E));
  });

  it("includes seeds even when they have no contact list", async () => {
    const wot = new Wot({ relay: createMockRelay([]), seeds: new Set([A]) });
    await wot.refresh();
    assert.deepEqual(wot.trusted(), new Set([A]));
  });

  it("ignores non-p tags and invalid pubkey values", async () => {
    const list = contactList(A, [B]);
    list.tags.push(["t", "hashtag"], ["p", "not-hex"], ["p", "ABC"], ["p"]);
    const wot = new Wot({
      relay: createMockRelay([list]),
      seeds: new Set([A]),
    });

    await wot.refresh();

    assert.deepEqual(wot.trusted(), new Set([A, B]));
  });

  it("lowercases uppercase hex p-tag values", async () => {
    const list = contactList(A, []);
    list.tags.push(["p", B.toUpperCase()]);
    const wot = new Wot({
      relay: createMockRelay([list]),
      seeds: new Set([A]),
    });

    await wot.refresh();

    assert.ok(wot.trusted()?.has(B));
  });

  it("batches contact-list queries by batchSize", async () => {
    const relay = createMockRelay([contactList(A, [B, C, D])]);
    const wot = new Wot({ relay, seeds: new Set([A]), batchSize: 2 });

    await wot.refresh();

    // Hop 1: one batch for the seed. Hop 2: frontier {B, C, D} split into
    // batches of 2 → two more queries.
    assert.equal(relay.queries.length, 3);
    assert.equal(relay.queries[1][0].authors?.length, 2);
    assert.equal(relay.queries[2][0].authors?.length, 1);
    for (const [filter] of relay.queries) {
      assert.deepEqual(filter.kinds, [3]);
      assert.equal(filter.limit, filter.authors?.length);
    }
  });

  it("keeps the previous set when a refresh fails", async () => {
    const relay = createMockRelay([contactList(A, [B])]);
    const wot = new Wot({ relay, seeds: new Set([A]) });
    await wot.refresh();
    assert.deepEqual(wot.trusted(), new Set([A, B]));

    relay.query = async () => {
      throw new Error("opensearch down");
    };

    await assert.rejects(() => wot.refresh(), /opensearch down/);
    // The old set survives the failed refresh.
    assert.deepEqual(wot.trusted(), new Set([A, B]));
  });
});
