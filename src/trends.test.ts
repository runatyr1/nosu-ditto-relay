import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent, NostrSigner, NRelay } from "@nostrify/nostrify";
import type { Client } from "./opensearch-client.ts";

import { Trends } from "./trends.ts";

/**
 * Minimal document shape stored in the mock.
 * Mirrors the `NostrEventDocument` from opensearch.ts.
 */
interface MockDocument {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
  tags_map: Record<string, string[]>;
  deleted: boolean;
}

/**
 * Build a `tags_map` from a Nostr tags array (same logic as OpenSearchRelay).
 */
function buildTagsMap(tags: string[][]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const tag of tags) {
    if (tag.length >= 2) {
      const [name, ...values] = tag;
      if (!map[name]) map[name] = [];
      map[name].push(...values);
    }
  }
  return map;
}

/**
 * Create a mock OpenSearch client that stores documents in-memory and
 * simulates the aggregation query issued by `getTrendingTagValues`.
 *
 * The mock handles the specific shape:
 * ```
 * {
 *   size: 0,
 *   query: { bool: { must: [...] } },
 *   aggs: {
 *     tag_<name>: {
 *       filter: { bool: { must: [...] } },
 *       aggs: {
 *         values: {
 *           terms: { field: "tags_map.<name>", size: N },
 *           aggs: { unique_authors: { cardinality: { field: "pubkey" } } }
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */
function createMockClient() {
  const documents: MockDocument[] = [];

  /** Check whether a document passes a set of bool/must clauses. */
  function matchesClauses(
    doc: MockDocument,
    clauses: Array<Record<string, unknown>>,
  ): boolean {
    for (const clause of clauses) {
      if (clause.term) {
        const entries = Object.entries(clause.term as Record<string, unknown>);
        for (const [field, expected] of entries) {
          if ((doc as unknown as Record<string, unknown>)[field] !== expected) {
            return false;
          }
        }
      }
      if (clause.terms) {
        const entries = Object.entries(
          clause.terms as Record<string, unknown[]>,
        );
        for (const [field, allowed] of entries) {
          // Handle nested fields like "tags_map.t"
          if (field.startsWith("tags_map.")) {
            const tagName = field.slice("tags_map.".length);
            const tagValues = doc.tags_map[tagName] ?? [];
            if (!tagValues.some((v) => allowed.includes(v))) {
              return false;
            }
          } else {
            const val = (doc as unknown as Record<string, unknown>)[field];
            if (!allowed.includes(val as never)) {
              return false;
            }
          }
        }
      }
      if (clause.range) {
        const entries = Object.entries(
          clause.range as Record<string, Record<string, number>>,
        );
        for (const [field, constraints] of entries) {
          const val = (doc as unknown as Record<string, unknown>)[
            field
          ] as number;
          if (typeof constraints.gte === "number" && val < constraints.gte)
            return false;
          if (typeof constraints.lte === "number" && val > constraints.lte)
            return false;
        }
      }
    }
    return true;
  }

  const client = {
    search: async ({ body }: { body: Record<string, unknown> }) => {
      const aggs = body.aggs as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (!aggs) {
        return { body: { hits: { hits: [] }, aggregations: {} } };
      }

      const aggregations: Record<string, unknown> = {};

      for (const [aggName, aggDef] of Object.entries(aggs)) {
        // Each top-level agg is a filter aggregation
        const filterDef = aggDef.filter as {
          bool: { must: Array<Record<string, unknown>> };
        };
        const subAggs = aggDef.aggs as Record<
          string,
          { terms: { field: string; size: number }; aggs?: unknown }
        >;

        // Find matching documents for this filter
        const matched = documents.filter((doc) =>
          matchesClauses(doc, filterDef.bool.must),
        );

        // Process the terms sub-aggregation (named "values")
        const termsAgg = subAggs.values;
        const field = termsAgg.terms.field; // e.g. "tags_map.t"
        const tagName = field.slice("tags_map.".length);
        const maxBuckets = termsAgg.terms.size;

        // Collect all tag values and group by value
        const valueBuckets = new Map<string, { docs: MockDocument[] }>();

        for (const doc of matched) {
          const tagValues = doc.tags_map[tagName] ?? [];
          for (const val of tagValues) {
            let bucket = valueBuckets.get(val);
            if (!bucket) {
              bucket = { docs: [] };
              valueBuckets.set(val, bucket);
            }
            bucket.docs.push(doc);
          }
        }

        // Build response buckets. The sub-agg decides the shape: trusted
        // mode asks for a per-pubkey `authors` terms agg, the default asks
        // for a `unique_authors` cardinality.
        const wantsAuthors = Boolean(
          (termsAgg.aggs as Record<string, unknown> | undefined)?.authors,
        );

        const buckets: Array<{
          key: string;
          doc_count: number;
          unique_authors?: { value: number };
          authors?: { buckets: Array<{ key: string; doc_count: number }> };
        }> = [];

        for (const [key, bucket] of valueBuckets.entries()) {
          if (wantsAuthors) {
            const byPubkey = new Map<string, number>();
            for (const doc of bucket.docs) {
              byPubkey.set(doc.pubkey, (byPubkey.get(doc.pubkey) ?? 0) + 1);
            }
            buckets.push({
              key,
              doc_count: bucket.docs.length,
              authors: {
                buckets: [...byPubkey.entries()].map(([pk, count]) => ({
                  key: pk,
                  doc_count: count,
                })),
              },
            });
          } else {
            const uniquePubkeys = new Set(bucket.docs.map((d) => d.pubkey));
            buckets.push({
              key,
              doc_count: bucket.docs.length,
              unique_authors: { value: uniquePubkeys.size },
            });
          }
        }

        // Sort by doc_count desc and limit
        buckets.sort((a, b) => b.doc_count - a.doc_count);
        buckets.splice(maxBuckets);

        aggregations[aggName] = {
          values: { buckets },
        };
      }

      return { body: { hits: { hits: [] }, aggregations } };
    },
    close: async () => {},
  };

  /** Helper to insert a document into the mock store. */
  function addEvent(event: NostrEvent): void {
    documents.push({
      ...event,
      tags_map: buildTagsMap(event.tags),
      deleted: false,
    });
  }

  return { client: client as unknown as Client, documents, addEvent };
}

/** Deterministic fake event builder (no real signatures needed for mock). */
function fakeEvent(
  overrides: Partial<NostrEvent> & { pubkey: string; kind: number },
): NostrEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    id:
      overrides.id ??
      crypto.randomUUID().replace(/-/g, "").slice(0, 64).padEnd(64, "0"),
    pubkey: overrides.pubkey,
    created_at: overrides.created_at ?? now,
    kind: overrides.kind,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
    sig: overrides.sig ?? "0".repeat(128),
  };
}

/** Create a mock NRelay that records events passed to it. */
function createMockRelay(): NRelay & { events: NostrEvent[] } {
  const events: NostrEvent[] = [];
  return {
    events,
    event: async (event: NostrEvent) => {
      events.push(event);
    },
    query: async () => [],
    req: async function* () {},
    count: async () => ({ count: 0 }),
    remove: async () => {},
  } as unknown as NRelay & { events: NostrEvent[] };
}

/** Create a mock NostrSigner that produces deterministic events. */
function createMockSigner(pubkey: string): NostrSigner {
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (event) => ({
      ...event,
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 64).padEnd(64, "0"),
      pubkey,
      sig: "0".repeat(128),
    }),
  };
}

/** Helper to create a Trends instance with mock dependencies. */
function createTrends(opts?: { trusted?: ReadonlySet<string> }) {
  const { client, documents, addEvent } = createMockClient();
  const relay = createMockRelay();
  const trends = new Trends({
    client,
    indexName: "test-index",
    relay,
    ...(opts?.trusted && { trustProvider: () => opts.trusted }),
  });
  return { trends, client, documents, addEvent, relay };
}

describe("Trends", () => {
  describe("getTrendingTagValues", () => {
    it("should return trending hashtags sorted by authors desc", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const pubkeyC = "c".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Three authors use #bitcoin
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "bitcoin"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 1,
          created_at: now - 10,
          tags: [["t", "bitcoin"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyC,
          kind: 1,
          created_at: now - 20,
          tags: [["t", "bitcoin"]],
        }),
      );

      // Two authors use #nostr
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 5,
          tags: [["t", "nostr"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 1,
          created_at: now - 15,
          tags: [["t", "nostr"]],
        }),
      );

      // One author uses #zap
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 30,
          tags: [["t", "zap"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 3);
      assert.equal(results[0].value, "bitcoin");
      assert.equal(results[0].authors, 3);
      assert.equal(results[0].uses, 3);
      assert.equal(results[1].value, "nostr");
      assert.equal(results[1].authors, 2);
      assert.equal(results[1].uses, 2);
      assert.equal(results[2].value, "zap");
      assert.equal(results[2].authors, 1);
      assert.equal(results[2].uses, 1);
    });

    it("should count uses separately from authors", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Same author posts about #bitcoin 5 times
      for (let i = 0; i < 5; i++) {
        addEvent(
          fakeEvent({
            pubkey: pubkeyA,
            kind: 1,
            created_at: now - i,
            tags: [["t", "bitcoin"]],
          }),
        );
      }

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, "bitcoin");
      assert.equal(results[0].authors, 1);
      assert.equal(results[0].uses, 5);
    });

    it("should respect the limit parameter", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "a"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 1,
          tags: [["t", "b"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 2,
          tags: [["t", "c"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 2,
      });

      assert.equal(results.length, 2);
    });

    it("should default limit to 20 when not specified", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Add 25 unique tags
      for (let i = 0; i < 25; i++) {
        addEvent(
          fakeEvent({
            pubkey: pubkeyA,
            kind: 1,
            created_at: now - i,
            tags: [["t", `tag${i.toString().padStart(2, "0")}`]],
          }),
        );
      }

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
      });

      assert.equal(results.length, 20);
    });

    it("should filter by kind", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Kind 1 event with #bitcoin
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "bitcoin"]],
        }),
      );
      // Kind 30023 event with #bitcoin (should be excluded)
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 30023,
          created_at: now - 10,
          tags: [["t", "bitcoin"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].uses, 1);
    });

    it("should filter by time range", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Event within range
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["t", "bitcoin"]],
        }),
      );
      // Event outside range (too old)
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 7200,
          tags: [["t", "nostr"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, "bitcoin");
    });

    it("should filter by authors", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "bitcoin"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 1,
          created_at: now - 10,
          tags: [["t", "nostr"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        authors: [pubkeyA],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, "bitcoin");
    });

    it("should restrict to allowed values when provided", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "bitcoin"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 1,
          tags: [["t", "nostr"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 2,
          tags: [["t", "zap"]],
        }),
      );

      const results = await trends.getTrendingTagValues(
        ["t"],
        { kinds: [1], since: now - 3600, until: now, limit: 10 },
        ["bitcoin", "nostr"],
      );

      assert.equal(results.length, 2);
      const values = results.map((r: { value: string }) => r.value);
      assert.ok(values.includes("bitcoin"));
      assert.ok(values.includes("nostr"));
      assert.ok(!values.includes("zap"));
    });

    it("should merge results across multiple tag names", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const eventId = "e".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Reference via e-tag
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["e", eventId]],
        }),
      );
      // Reference via q-tag (same event)
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 1,
          created_at: now - 10,
          tags: [["q", eventId]],
        }),
      );

      const results = await trends.getTrendingTagValues(["e", "q"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, eventId);
      // Uses should be summed across both tag names
      assert.equal(results[0].uses, 2);
      // Authors should be the max across both tag names (different authors)
      assert.ok(results[0].authors >= 1);
    });

    it("should lowercase tag values", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "Bitcoin"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 1,
          created_at: now - 10,
          tags: [["t", "BITCOIN"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      // Both should merge into a single lowercase entry.
      // Note: authors is approximate (max across buckets) since OpenSearch
      // returns case-sensitive buckets that get merged client-side.
      assert.equal(results.length, 1);
      assert.equal(results[0].value, "bitcoin");
      assert.equal(results[0].uses, 2);
      assert.ok(results[0].authors >= 1);
    });

    it("should return empty results when no events match", async () => {
      const { trends } = createTrends();
      const now = Math.floor(Date.now() / 1000);

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 0);
    });

    it("should exclude deleted events", async () => {
      const { trends, documents } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Manually push a deleted document
      documents.push({
        id: "d".repeat(64),
        pubkey: pubkeyA,
        created_at: now,
        kind: 1,
        tags: [["t", "bitcoin"]],
        content: "",
        sig: "0".repeat(128),
        tags_map: { t: ["bitcoin"] },
        deleted: true,
      });

      // And a non-deleted one
      documents.push({
        id: "e".repeat(64),
        pubkey: pubkeyA,
        created_at: now - 10,
        kind: 1,
        tags: [["t", "nostr"]],
        content: "",
        sig: "0".repeat(128),
        tags_map: { t: ["nostr"] },
        deleted: false,
      });

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, "nostr");
    });

    it("should handle events with multiple tag values", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // One event with multiple hashtags
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [
            ["t", "bitcoin"],
            ["t", "nostr"],
            ["t", "zap"],
          ],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 3);
      const values = results.map((r: { value: string }) => r.value);
      assert.ok(values.includes("bitcoin"));
      assert.ok(values.includes("nostr"));
      assert.ok(values.includes("zap"));
    });

    it("should work with trending pubkeys (p-tag)", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const trendingPubkey = "f".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Two authors reference the same pubkey
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["p", trendingPubkey]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 9735,
          created_at: now - 10,
          tags: [["p", trendingPubkey]],
        }),
      );

      const results = await trends.getTrendingTagValues(["p"], {
        kinds: [1, 3, 6, 7, 9735],
        since: now - 3600,
        until: now,
        limit: 40,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, trendingPubkey);
      assert.equal(results[0].authors, 2);
      assert.equal(results[0].uses, 2);
    });

    it("should work without since/until filters", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "bitcoin"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, "bitcoin");
    });

    it("should sort by authors first, then uses as tiebreaker", async () => {
      const { trends, addEvent } = createTrends();

      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // "nostr" has 2 authors, 2 uses
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now,
          tags: [["t", "nostr"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 1,
          created_at: now - 1,
          tags: [["t", "nostr"]],
        }),
      );

      // "bitcoin" has 1 author, 5 uses (more uses but fewer authors)
      for (let i = 0; i < 5; i++) {
        addEvent(
          fakeEvent({
            pubkey: pubkeyA,
            kind: 1,
            created_at: now - i - 10,
            tags: [["t", "bitcoin"]],
          }),
        );
      }

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      // "nostr" should rank first (more authors), "bitcoin" second (more uses but fewer authors)
      assert.equal(results[0].value, "nostr");
      assert.equal(results[0].authors, 2);
      assert.equal(results[1].value, "bitcoin");
      assert.equal(results[1].authors, 1);
      assert.equal(results[1].uses, 5);
    });
  });

  describe("getTrendingTagValues with trust provider", () => {
    it("counts only trusted authors and drops untrusted-only values", async () => {
      const trustedA = "a".repeat(64);
      const trustedB = "b".repeat(64);
      const puppet1 = "c".repeat(64);
      const puppet2 = "d".repeat(64);
      const puppet3 = "e".repeat(64);

      const { trends, addEvent } = createTrends({
        trusted: new Set([trustedA, trustedB]),
      });
      const now = Math.floor(Date.now() / 1000);

      // #organic: two trusted authors, one puppet.
      for (const [pubkey, offset] of [
        [trustedA, 0],
        [trustedB, 10],
        [puppet1, 20],
      ] as const) {
        addEvent(
          fakeEvent({
            pubkey,
            kind: 1,
            created_at: now - offset,
            tags: [["t", "organic"]],
          }),
        );
      }

      // #botted: three puppets, zero trusted authors — more raw authors
      // and uses than #organic, but it must not trend at all.
      for (const [pubkey, offset] of [
        [puppet1, 0],
        [puppet2, 5],
        [puppet2, 15],
        [puppet3, 25],
      ] as const) {
        addEvent(
          fakeEvent({
            pubkey,
            kind: 1,
            created_at: now - offset,
            tags: [["t", "botted"]],
          }),
        );
      }

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].value, "organic");
      // Puppet contributions are excluded from both counts.
      assert.equal(results[0].authors, 2);
      assert.equal(results[0].uses, 2);
    });

    it("counts every author when no trust provider is configured", async () => {
      const { trends, addEvent } = createTrends();
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: "a".repeat(64),
          kind: 1,
          created_at: now,
          tags: [["t", "anything"]],
        }),
      );

      const results = await trends.getTrendingTagValues(["t"], {
        kinds: [1],
        since: now - 3600,
        until: now,
        limit: 10,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].authors, 1);
    });
  });

  describe("updateTrendingTags", () => {
    it("should publish a kind 1985 label event with trending values", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signerPubkey = "s".repeat(64);
      const signer = createMockSigner(signerPubkey);
      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["t", "bitcoin"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 1,
          created_at: now - 200,
          tags: [["t", "bitcoin"]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 300,
          tags: [["t", "nostr"]],
        }),
      );

      await trends.updateTrendingTags(signer, "#t", "t", [1], 20);

      assert.equal(relay.events.length, 1);
      const label = relay.events[0];
      assert.equal(label.kind, 1985);
      assert.equal(label.pubkey, signerPubkey);

      // Check label namespace tags
      const lTag = label.tags.find((t: string[]) => t[0] === "L");
      assert.deepEqual(lTag, ["L", "pub.ditto.trends"]);
      const lValueTag = label.tags.find((t: string[]) => t[0] === "l");
      assert.deepEqual(lValueTag, ["l", "#t", "pub.ditto.trends"]);

      // Check trending value tags
      const tTags = label.tags.filter((t: string[]) => t[0] === "t");
      assert.equal(tTags.length, 2);
      // First should be "bitcoin" (2 authors)
      assert.equal(tTags[0][1], "bitcoin");
      assert.equal(tTags[0][3], "2"); // authors
      assert.equal(tTags[0][4], "2"); // uses
    });

    it("should not publish when no trends are found", async () => {
      const { trends, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));

      await trends.updateTrendingTags(signer, "#t", "t", [1], 20);

      assert.equal(relay.events.length, 0);
    });

    it("should include extra value in tag tuples", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));
      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["p", "f".repeat(64)]],
        }),
      );

      await trends.updateTrendingTags(
        signer,
        "#p",
        "p",
        [1],
        40,
        "wss://relay.example.com/",
      );

      assert.equal(relay.events.length, 1);
      const pTags = relay.events[0].tags.filter((t: string[]) => t[0] === "p");
      assert.equal(pTags[0][2], "wss://relay.example.com/");
    });

    it("should support aliases for tag names", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));
      const pubkeyA = "a".repeat(64);
      const pubkeyB = "b".repeat(64);
      const eventId = "e".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      // Reference via e-tag
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["e", eventId]],
        }),
      );
      // Reference via q-tag (alias)
      addEvent(
        fakeEvent({
          pubkey: pubkeyB,
          kind: 6,
          created_at: now - 200,
          tags: [["q", eventId]],
        }),
      );

      await trends.updateTrendingTags(
        signer,
        "#e",
        "e",
        [1, 6, 7, 9735],
        40,
        "wss://relay.example.com/",
        ["q"],
      );

      assert.equal(relay.events.length, 1);
      // The primary tag name "e" should be used in the label event
      const eTags = relay.events[0].tags.filter((t: string[]) => t[0] === "e");
      assert.equal(eTags.length, 1);
      assert.equal(eTags[0][1], eventId);
    });
  });

  describe("updateTrendingHashtags", () => {
    it("should query kind 1 events for t-tags with limit 20", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));
      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["t", "bitcoin"]],
        }),
      );

      await trends.updateTrendingHashtags(signer);

      assert.equal(relay.events.length, 1);
      const label = relay.events[0];
      const lValueTag = label.tags.find((t: string[]) => t[0] === "l");
      assert.deepEqual(lValueTag, ["l", "#t", "pub.ditto.trends"]);
      const tTags = label.tags.filter((t: string[]) => t[0] === "t");
      assert.equal(tTags[0][1], "bitcoin");
      // extra should be empty for hashtags
      assert.equal(tTags[0][2], "");
    });
  });

  describe("updateTrendingLinks", () => {
    it("should query kind 1 events for r-tags with limit 20", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));
      const pubkeyA = "a".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["r", "https://example.com"]],
        }),
      );

      await trends.updateTrendingLinks(signer);

      assert.equal(relay.events.length, 1);
      const label = relay.events[0];
      const lValueTag = label.tags.find((t: string[]) => t[0] === "l");
      assert.deepEqual(lValueTag, ["l", "#r", "pub.ditto.trends"]);
      const rTags = label.tags.filter((t: string[]) => t[0] === "r");
      assert.equal(rTags[0][1], "https://example.com");
    });
  });

  describe("updateTrendingPubkeys", () => {
    it("should query multiple kinds for p-tags with relay URL as extra", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));
      const pubkeyA = "a".repeat(64);
      const trendingPubkey = "f".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["p", trendingPubkey]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 7,
          created_at: now - 200,
          tags: [["p", trendingPubkey]],
        }),
      );

      await trends.updateTrendingPubkeys(signer, "wss://relay.example.com/");

      assert.equal(relay.events.length, 1);
      const label = relay.events[0];
      const lValueTag = label.tags.find((t: string[]) => t[0] === "l");
      assert.deepEqual(lValueTag, ["l", "#p", "pub.ditto.trends"]);
      const pTags = label.tags.filter((t: string[]) => t[0] === "p");
      assert.equal(pTags[0][1], trendingPubkey);
      assert.equal(pTags[0][2], "wss://relay.example.com/");
    });
  });

  describe("updateTrendingEvents", () => {
    it("should query e and q tags with relay URL as extra", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));
      const pubkeyA = "a".repeat(64);
      const eventId = "e".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 1,
          created_at: now - 100,
          tags: [["e", eventId]],
        }),
      );
      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 6,
          created_at: now - 200,
          tags: [["q", eventId]],
        }),
      );

      await trends.updateTrendingEvents(signer, "wss://relay.example.com/");

      assert.equal(relay.events.length, 1);
      const label = relay.events[0];
      const lValueTag = label.tags.find((t: string[]) => t[0] === "l");
      assert.deepEqual(lValueTag, ["l", "#e", "pub.ditto.trends"]);
      const eTags = label.tags.filter((t: string[]) => t[0] === "e");
      assert.equal(eTags[0][1], eventId);
      assert.equal(eTags[0][2], "wss://relay.example.com/");
    });
  });

  describe("updateTrendingZappedEvents", () => {
    it("should query kind 9735 for e and q tags", async () => {
      const { trends, addEvent, relay } = createTrends();

      const signer = createMockSigner("s".repeat(64));
      const pubkeyA = "a".repeat(64);
      const eventId = "e".repeat(64);
      const now = Math.floor(Date.now() / 1000);

      addEvent(
        fakeEvent({
          pubkey: pubkeyA,
          kind: 9735,
          created_at: now - 100,
          tags: [["e", eventId]],
        }),
      );

      await trends.updateTrendingZappedEvents(
        signer,
        "wss://relay.example.com/",
      );

      assert.equal(relay.events.length, 1);
      const label = relay.events[0];
      const lValueTag = label.tags.find((t: string[]) => t[0] === "l");
      assert.deepEqual(lValueTag, ["l", "zapped", "pub.ditto.trends"]);
      const eTags = label.tags.filter((t: string[]) => t[0] === "e");
      assert.equal(eTags[0][1], eventId);
      assert.equal(eTags[0][2], "wss://relay.example.com/");
    });
  });
});
