import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { Config } from "./config.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type { Client } from "./opensearch-client.ts";

describe("OpenSearchRelay", () => {
  // Shared mock OpenSearch client. It evaluates queries for real (rather than
  // returning whatever is stored), so tests exercise actual filter matching —
  // which is the whole point when the thing under test is a query builder.

  /** Helper: extract filter criteria from a bool query (flat or nested). */
  const extractFilters = (
    boolQuery: Record<string, unknown>,
  ): {
    authorFilter?: string[];
    kindFilter?: number[];
    idFilter?: string[];
    excludeIds?: string[];
    excludeKinds?: number[];
    /** NIP-40: exclude docs whose `expiration` tag is at or before this time. */
    excludeExpiredAt?: number;
    requireReplaced: boolean;
    requireReplacedFalse: boolean;
    excludeReplaced: boolean;
    untilFilter?: number;
    tagFilters: Map<string, string[]>;
  } => {
    let authorFilter: string[] | undefined;
    let kindFilter: number[] | undefined;
    let idFilter: string[] | undefined;
    let excludeIds: string[] | undefined;
    let excludeKinds: number[] | undefined;
    let excludeExpiredAt: number | undefined;
    let requireReplaced = false;
    let requireReplacedFalse = false;
    let excludeReplaced = false;
    let untilFilter: number | undefined;
    const tagFilters = new Map<string, string[]>();

    /**
     * Collect exclusions from a `must_not` array. Applies at any depth: a
     * `buildQuery` result nested inside an outer bool (as deletion does)
     * carries its exclusions with it.
     */
    const processMustNot = (
      clauses: Array<Record<string, unknown>>,
      nested: boolean,
    ) => {
      for (const clause of clauses) {
        const term = clause.term as Record<string, unknown> | undefined;
        const terms = clause.terms as Record<string, unknown> | undefined;

        if (term?.replaced === true) {
          // Nested, this negates an outer `must: replaced` rather than
          // standing on its own.
          if (nested) requireReplaced = false;
          else excludeReplaced = true;
        }
        if (term?.id) {
          excludeIds = excludeIds || [];
          excludeIds.push(term.id as string);
        }
        if (terms?.id) {
          excludeIds = excludeIds || [];
          excludeIds.push(...(terms.id as string[]));
        }
        if (terms?.kind) {
          excludeKinds = excludeKinds || [];
          excludeKinds.push(...(terms.kind as number[]));
        }
        const expiration = (
          clause.range as Record<string, unknown> | undefined
        )?.["tags_map.expiration"] as { lte?: string } | undefined;
        if (expiration?.lte !== undefined) {
          excludeExpiredAt = Number(expiration.lte);
        }
      }
    };

    const processClauses = (clauses: Array<Record<string, unknown>>) => {
      for (const clause of clauses) {
        // Direct term/terms at this level
        const terms = clause.terms as Record<string, unknown> | undefined;
        const term = clause.term as Record<string, unknown> | undefined;

        if (term?.replaced === true) requireReplaced = true;
        if (term?.replaced === false) requireReplacedFalse = true;
        if (term?.deleted === false) {
          /* always excluded by default */
        }
        if (terms?.pubkey) authorFilter = terms.pubkey as string[];
        if (terms?.kind) kindFilter = (terms.kind as number[]).map(Number);
        if (terms?.id) idFilter = terms.id as string[];
        if (term?.kind !== undefined) kindFilter = [Number(term.kind)];
        if (term?.pubkey) authorFilter = [term.pubkey as string];
        if (clause.range) {
          const createdAt = (clause.range as Record<string, unknown>)
            .created_at as { lte?: number } | undefined;
          if (createdAt?.lte) untilFilter = createdAt.lte;
        }

        // Extract tags_map filters
        if (terms) {
          for (const [key, val] of Object.entries(terms)) {
            if (key.startsWith("tags_map.")) {
              tagFilters.set(key.replace("tags_map.", ""), val as string[]);
            }
          }
        }
        if (term) {
          for (const [key, val] of Object.entries(term)) {
            if (key.startsWith("tags_map.")) {
              tagFilters.set(key.replace("tags_map.", ""), [val as string]);
            }
          }
        }

        // Recurse into nested bool
        if (clause.bool) {
          const nested = clause.bool as Record<string, unknown>;
          if (nested.must)
            processClauses(nested.must as Array<Record<string, unknown>>);
          if (nested.must_not) {
            processMustNot(
              nested.must_not as Array<Record<string, unknown>>,
              true,
            );
          }
        }
      }
    };

    const must = (boolQuery.must as Array<Record<string, unknown>>) || [];
    const mustNot =
      (boolQuery.must_not as Array<Record<string, unknown>>) || [];

    processClauses(must);
    processMustNot(mustNot, false);

    return {
      authorFilter,
      kindFilter,
      idFilter,
      excludeIds,
      excludeKinds,
      excludeExpiredAt,
      requireReplaced,
      requireReplacedFalse,
      excludeReplaced,
      untilFilter,
      tagFilters,
    };
  };

  /** Helper: test whether a document matches extracted filters. */
  const matchesFilters = (
    d: NostrEvent & {
      deleted?: boolean;
      replaced?: boolean;
      tags_map?: Record<string, string[]>;
    },
    filters: ReturnType<typeof extractFilters>,
  ): boolean => {
    if (d.deleted) return false;
    if (filters.excludeReplaced && d.replaced) return false;
    if (filters.requireReplaced && !d.replaced) return false;
    if (filters.requireReplacedFalse && d.replaced) return false;
    if (filters.authorFilter && !filters.authorFilter.includes(d.pubkey))
      return false;
    if (filters.kindFilter && !filters.kindFilter.includes(d.kind))
      return false;
    if (filters.idFilter && !filters.idFilter.includes(d.id)) return false;
    if (filters.excludeIds?.includes(d.id)) return false;
    if (filters.excludeKinds?.includes(d.kind)) return false;
    if (filters.excludeExpiredAt !== undefined) {
      const expiration = d.tags_map?.expiration?.[0];
      if (
        expiration !== undefined &&
        Number(expiration) <= filters.excludeExpiredAt
      )
        return false;
    }
    if (filters.untilFilter && d.created_at > filters.untilFilter) return false;

    for (const [tagName, values] of filters.tagFilters) {
      const docValues = d.tags_map?.[tagName] ?? [];
      if (!values.some((v) => docValues.includes(v))) return false;
    }
    return true;
  };

  /**
   * Match a document against a `bool` query, handling `must`, `must_not`,
   * `should`, and `ids` clauses. Recurses for batched slot-cleanup queries
   * that combine multiple per-slot `bool.must` clauses inside `bool.should`.
   */
  const matchesQueryBool = (
    d: NostrEvent & {
      deleted?: boolean;
      replaced?: boolean;
      tags_map?: Record<string, string[]>;
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
    bool: any,
  ): boolean => {
    // must_not: { ids: { values: [...] } } excludes specific docs by ID.
    const mustNot = (bool.must_not ?? []) as Array<Record<string, unknown>>;
    for (const clause of mustNot) {
      const ids = (clause.ids as { values?: string[] } | undefined)?.values;
      if (ids?.includes(d.id)) return false;
    }

    // should: [{ bool: {...} }, ...] with minimum_should_match: 1 means at
    // least one inner bool must match.
    const should = bool.should as Array<Record<string, unknown>> | undefined;
    if (should && should.length > 0) {
      const min = (bool.minimum_should_match as number | undefined) ?? 1;
      let matched = 0;
      for (const clause of should) {
        const inner = clause.bool as Record<string, unknown> | undefined;
        if (inner && matchesQueryBool(d, inner)) {
          matched++;
          if (matched >= min) break;
        }
      }
      if (matched < min) return false;
    }

    // Fall back to the flat-must/must_not extractor for the leaf bool case.
    const filters = extractFilters(bool);
    return matchesFilters(d, filters);
  };

  const createHistoryMockClient = () => {
    const documents = new Map<string, unknown>();
    // Docs indexed but not yet visible to search, modelling OpenSearch's
    // refresh_interval. `get` still sees them (realtime), searches don't.
    // Off by default; `setDeferVisibility(true)` makes subsequent bulk
    // index ops land here until `refresh()` is called.
    const unsearchable = new Set<string>();
    let deferVisibility = false;
    // biome-ignore lint/suspicious/noExplicitAny: shared search impl reused by msearch
    const runSearch = (body: any) => {
      const results: unknown[] = [];
      const filters = extractFilters(body.query.bool);

      for (const [id, doc] of documents.entries()) {
        if (unsearchable.has(id)) continue;
        const d = doc as NostrEvent & {
          deleted?: boolean;
          replaced?: boolean;
          tags_map?: Record<string, string[]>;
        };
        if (!matchesFilters(d, filters)) continue;
        results.push(doc);
      }

      // Matches the relay's msearch sort: newest first, lowest id breaks
      // ties.
      results.sort((a, b) => {
        const ea = a as NostrEvent;
        const eb = b as NostrEvent;
        if (eb.created_at !== ea.created_at) {
          return eb.created_at - ea.created_at;
        }
        return ea.id < eb.id ? -1 : ea.id > eb.id ? 1 : 0;
      });

      const size = body.size ?? results.length;
      return {
        hits: {
          hits: results.slice(0, size).map((doc) => ({ _source: doc })),
        },
      };
    };
    return {
      documents,
      /** Simulate refresh lag for subsequently indexed documents. */
      setDeferVisibility: (value: boolean) => {
        deferVisibility = value;
      },
      /** Make every indexed document searchable, as a refresh would. */
      refresh: () => {
        unsearchable.clear();
      },
      client: {
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        search: async ({ body }: { body: any }) => {
          return { body: runSearch(body) };
        },
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        msearch: async (requests: Array<{ body: any }>) => {
          const responses = requests.map((req) => runSearch(req.body));
          return { body: { responses } };
        },
        bulk: async ({ body }: { body: unknown[] }) => {
          const items: Array<Record<string, unknown>> = [];
          // `index` and `update` actions are followed by a source line;
          // `delete` actions stand alone.
          for (let i = 0; i < body.length; i++) {
            const action = body[i] as {
              index?: { _id: string };
              update?: { _id: string };
              delete?: { _id: string };
            };

            if (action.delete) {
              documents.delete(action.delete._id);
              unsearchable.delete(action.delete._id);
              items.push({ delete: {} });
              continue;
            }

            const payload = body[++i] as Record<string, unknown>;

            if (action.index) {
              documents.set(action.index._id, payload);
              if (deferVisibility) unsearchable.add(action.index._id);
              items.push({ index: {} });
            } else if (action.update) {
              if (payload.doc) {
                const existing = documents.get(action.update._id);
                if (existing) {
                  documents.set(action.update._id, {
                    ...existing,
                    ...(payload.doc as Record<string, unknown>),
                  });
                }
              }
              items.push({ update: {} });
            }
          }
          return { body: { errors: false, items } };
        },
        get: async ({ id }: { id: string }) => {
          const doc = documents.get(id);
          if (doc) return { body: { found: true, _source: doc } };
          return { body: { found: false }, statusCode: 404 };
        },
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        deleteByQuery: async ({ body }: { body: any }) => {
          const matchesQuery = (
            d: NostrEvent & {
              deleted?: boolean;
              replaced?: boolean;
              tags_map?: Record<string, string[]>;
            },
          ): boolean => matchesQueryBool(d, body.query.bool);
          let deleted = 0;

          for (const [id, doc] of documents.entries()) {
            if (unsearchable.has(id)) continue;
            const d = doc as NostrEvent & {
              deleted?: boolean;
              replaced?: boolean;
              tags_map?: Record<string, string[]>;
            };
            if (!matchesQuery(d)) continue;
            documents.delete(id);
            deleted++;
          }

          return { body: { deleted } };
        },
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        updateByQuery: async ({ body }: { body: any }) => {
          let updated = 0;

          for (const [id, doc] of documents.entries()) {
            if (unsearchable.has(id)) continue;
            const d = doc as NostrEvent & {
              deleted?: boolean;
              replaced?: boolean;
              tags_map?: Record<string, string[]>;
            };
            if (!matchesQueryBool(d, body.query.bool)) continue;

            const script = body.script.source as string;
            if (script.includes("ctx._source.deleted = true")) {
              (d as Record<string, unknown>).deleted = true;
              updated++;
            } else if (script.includes("ctx._source.replaced = true")) {
              (d as Record<string, unknown>).replaced = true;
              (d as Record<string, unknown>).followers = 0;
              (d as Record<string, unknown>).engagers = 0;
              (d as Record<string, unknown>).comment_cnt = 0;
              (d as Record<string, unknown>).reaction_cnt = 0;
              (d as Record<string, unknown>).repost_cnt = 0;
              (d as Record<string, unknown>).quote_cnt = 0;
              (d as Record<string, unknown>).zap_amount_msats = 0;
              (d as Record<string, unknown>).zap_cnt = 0;
              updated++;
            }
          }

          return { body: { updated } };
        },
        indices: {
          exists: async () => ({ body: true }),
          create: async () => ({ body: {} }),
        },
        close: async () => {},
      },
    };
  };

  /** Minimum env required to construct a Config (RELAY_URL and NOSTR_NSEC are mandatory). */
  const baseEnv = (...overrides: [string, string][]): Map<string, string> =>
    new Map<string, string>([
      ["RELAY_URL", "wss://relay.example.com/"],
      [
        "NOSTR_NSEC",
        "nsec1l2xejwnzu9sjl9ve3eryktge5u05esdez9ll3wt9gly9n7yraq4sph4kgh",
      ],
      ...overrides,
    ]);

  it("should create relay with default config", () => {
    const config = new Config(baseEnv());

    const relay = OpenSearchRelay.fromConfig(config);

    assert.ok(relay instanceof OpenSearchRelay);
  });

  it("should create relay with custom node", () => {
    const config = new Config(
      baseEnv(["OPENSEARCH_NODE", "http://example.com:9200"]),
    );

    const relay = OpenSearchRelay.fromConfig(config);

    assert.ok(relay instanceof OpenSearchRelay);
  });

  it("should create relay with auth when credentials provided", () => {
    const config = new Config(
      baseEnv(
        ["OPENSEARCH_USERNAME", "admin"],
        ["OPENSEARCH_PASSWORD", "password123"],
      ),
    );

    const relay = OpenSearchRelay.fromConfig(config);

    assert.ok(relay instanceof OpenSearchRelay);
  });

  describe("event deletion", () => {
    it("should delete events by e-tag (event ID)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Event to delete",
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by event ID
      await relay.remove([{ ids: [event.id] }]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });

    it("should delete addressable events by a-tag", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();

      const event = finalizeEvent(
        {
          kind: 30023, // Addressable event kind
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "my-article"]],
          content: "Article content",
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by a-tag filter (kind:pubkey:d-tag)
      await relay.remove([
        {
          kinds: [30023],
          authors: [event.pubkey],
          "#d": ["my-article"],
        },
      ]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });

    it("should delete replaceable events by kind and author", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 0, // Replaceable event kind (metadata)
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by kind and author
      await relay.remove([
        {
          kinds: [0],
          authors: [event.pubkey],
        },
      ]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });

    it("should not delete events from different authors", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Event from author 1",
        },
        sk1,
      );

      // Store the event
      await relay.event(event1);

      // Try to delete with different author
      await relay.remove([
        {
          ids: [event1.id],
          authors: [
            finalizeEvent(
              { kind: 1, created_at: 0, tags: [], content: "" },
              sk2,
            ).pubkey,
          ],
        },
      ]);

      // Verify the event is NOT deleted (different author)
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.notEqual(stored.deleted, true);
    });

    it("should delete replaceable events using a-tag with empty d-identifier", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 10000, // Replaceable event kind
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Replaceable event",
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by kind and author (empty d-tag for replaceable events)
      await relay.remove([
        {
          kinds: [10000],
          authors: [event.pubkey],
        },
      ]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });

    it("should index new replaceable event as a separate document", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store an initial kind 0 event
      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );

      await relay.event(event1);

      // Now replace with a newer kind 0 event from the same author
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );

      await relay.event(event2);

      // Both events are indexed as separate documents (new design: each
      // event gets its own noteEncode doc ID). The old one is marked as
      // replaced by flush()'s updateByQuery phase.
      assert.equal(
        documents.size,
        2,
        "Both events should be indexed as separate documents",
      );

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      assert.ok(
        docs.some((d) => d.id === event2.id),
        "New event should exist",
      );
    });
  });

  describe("replaceable event history", () => {
    it("should archive old version when a replaceable event is replaced", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store initial kind 0 event
      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Replace with newer kind 0 event
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );
      await relay.event(event2);

      // Should have 2 documents: the current and the replaced history version
      assert.equal(documents.size, 2, "Should have current + history document");

      // Find the history document (has replaced: true)
      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const historyDoc = docs.find((d) => d.replaced === true);
      const currentDoc = docs.find((d) => !d.replaced);

      assert.ok(historyDoc, "Should have a history document");
      assert.ok(currentDoc, "Should have a current document");
      assert.equal(
        historyDoc?.id,
        event1.id,
        "History should be the old event",
      );
      assert.equal(
        currentDoc?.id,
        event2.id,
        "Current should be the new event",
      );
    });

    it("should archive old version when an addressable event is replaced", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "my-article"]],
          content: "Version 1",
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "my-article"]],
          content: "Version 2",
        },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history document");

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const historyDoc = docs.find((d) => d.replaced === true);
      const currentDoc = docs.find((d) => !d.replaced);

      assert.ok(historyDoc, "Should have a history document");
      assert.equal(historyDoc?.id, event1.id);
      assert.equal(currentDoc?.id, event2.id);
    });

    it("should mark older incoming event as replaced", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store the newer event first
      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Store an older event for the same slot — gets indexed but marked replaced
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Old Alice" }),
        },
        sk,
      );
      await relay.event(event2);

      // Both events exist, but the older one should be marked replaced
      assert.equal(documents.size, 2, "Both events should be indexed");

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const current = docs.find((d) => !d.replaced);
      const replaced = docs.find((d) => d.replaced === true);

      assert.ok(current, "Should have a current event");
      assert.ok(replaced, "Should have a replaced event");
      assert.equal(current?.id, event1.id, "Newer event should be current");
      assert.equal(replaced?.id, event2.id, "Older event should be replaced");
    });

    // Phase 2 waits one refresh_interval before searching for the document
    // it just indexed, which is not a guarantee — the msearch regularly
    // outruns the refresh cycle in production. When that happens the
    // just-indexed event is missing from the hits, and treating the top hit
    // as the slot winner leaves two live versions behind on every update.
    describe("slot resolution when the new event is not yet searchable", () => {
      const mkArticle = (sk: Uint8Array, createdAt: number, content: string) =>
        finalizeEvent(
          {
            kind: 30023,
            created_at: createdAt,
            content,
            tags: [["d", "my-article"]],
          },
          sk,
        );

      it("should replace the prior version when the new one is unsearchable", async () => {
        const mock = createHistoryMockClient();
        const relay = new OpenSearchRelay(mock.client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();

        const v1 = mkArticle(sk, 1000, "article-v1");
        await relay.event(v1);
        mock.refresh();

        mock.setDeferVisibility(true);
        const v2 = mkArticle(sk, 2000, "article-v2");
        await relay.event(v2);
        mock.refresh();

        const docs = Array.from(mock.documents.values()) as Array<
          NostrEvent & { replaced?: boolean }
        >;
        const live = docs.filter((d) => !d.replaced);

        assert.equal(
          live.length,
          1,
          "Slot should have exactly one live version",
        );
        assert.equal(live[0].id, v2.id, "The newest version should be live");
        assert.equal(
          docs.find((d) => d.id === v1.id)?.replaced,
          true,
          "The prior version should be marked replaced",
        );
      });

      it("should converge on one live version across repeated updates", async () => {
        const mock = createHistoryMockClient();
        const relay = new OpenSearchRelay(mock.client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();
        const versions: NostrEvent[] = [];

        // Every write lands while the previous refresh has already caught
        // up but its own has not — the steady state in production.
        mock.setDeferVisibility(true);
        for (let i = 1; i <= 5; i++) {
          const version = mkArticle(sk, 1000 * i, `article-v${i}`);
          versions.push(version);
          await relay.event(version);
          mock.refresh();
        }

        const docs = Array.from(mock.documents.values()) as Array<
          NostrEvent & { replaced?: boolean }
        >;
        const live = docs.filter((d) => !d.replaced);

        assert.equal(docs.length, 5, "All versions should be retained");
        assert.equal(
          live.length,
          1,
          "Slot should have exactly one live version",
        );
        assert.equal(
          live[0].id,
          versions[versions.length - 1].id,
          "The newest version should be the live one",
        );
      });

      it("should replace a late older version that is unsearchable", async () => {
        const mock = createHistoryMockClient();
        const relay = new OpenSearchRelay(mock.client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();

        const newer = mkArticle(sk, 2000, "article-v2");
        await relay.event(newer);
        mock.refresh();

        mock.setDeferVisibility(true);
        const older = mkArticle(sk, 1000, "article-v1");
        await relay.event(older);
        mock.refresh();

        const docs = Array.from(mock.documents.values()) as Array<
          NostrEvent & { replaced?: boolean }
        >;
        const live = docs.filter((d) => !d.replaced);

        assert.equal(
          live.length,
          1,
          "Slot should have exactly one live version",
        );
        assert.equal(
          live[0].id,
          newer.id,
          "The newer version should stay live",
        );
        assert.equal(
          docs.find((d) => d.id === older.id)?.replaced,
          true,
          "The late older version should be marked replaced",
        );
      });

      it("should delete prior versions, not the new one, when history is disabled", async () => {
        const mock = createHistoryMockClient();
        const relay = new OpenSearchRelay(mock.client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
          historyEnabled: false,
        });

        const sk = generateSecretKey();

        const v1 = mkArticle(sk, 1000, "article-v1");
        await relay.event(v1);
        mock.refresh();

        mock.setDeferVisibility(true);
        const v2 = mkArticle(sk, 2000, "article-v2");
        await relay.event(v2);
        mock.refresh();

        const remaining = Array.from(mock.documents.values()) as NostrEvent[];
        assert.equal(remaining.length, 1, "Only one version should survive");
        assert.equal(
          remaining[0].id,
          v2.id,
          "The newest version should survive",
        );
      });

      it("should delete a late older version that is unsearchable", async () => {
        const mock = createHistoryMockClient();
        const relay = new OpenSearchRelay(mock.client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
          historyEnabled: false,
        });

        const sk = generateSecretKey();

        const newer = mkArticle(sk, 2000, "article-v2");
        await relay.event(newer);
        mock.refresh();

        mock.setDeferVisibility(true);
        const older = mkArticle(sk, 1000, "article-v1");
        await relay.event(older);
        mock.refresh();

        const remaining = Array.from(mock.documents.values()) as NostrEvent[];
        assert.equal(remaining.length, 1, "Only one version should survive");
        assert.equal(
          remaining[0].id,
          newer.id,
          "The newer version should survive",
        );
      });
    });

    it("should not archive a duplicate event", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);
      await relay.event(event1); // Send the same event again

      assert.equal(
        documents.size,
        1,
        "Should not create history for duplicate",
      );
    });

    it("should strip score fields from history documents", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Simulate accumulated scores
      const doc = Array.from(documents.values())[0] as Record<string, unknown>;
      doc.followers = 42;
      doc.engagers = 7;

      // Replace
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );
      await relay.event(event2);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const historyDoc = docs.find((d) => d.replaced === true);

      assert.ok(historyDoc, "Should have a history document");
      assert.equal(
        historyDoc?.followers,
        0,
        "followers should be zeroed on history",
      );
      assert.equal(
        historyDoc?.engagers,
        0,
        "engagers should be zeroed on history",
      );
    });

    it("should index new event even when old version is soft-deleted", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Soft-delete the document
      const doc = Array.from(documents.values())[0] as Record<string, unknown>;
      doc.deleted = true;

      // Store a newer event — should still be accepted
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );
      await relay.event(event2);

      // New event is indexed; deleted event remains deleted
      assert.equal(
        documents.size,
        2,
        "New event should be indexed alongside deleted one",
      );

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { deleted?: boolean }
      >;
      const live = docs.filter((d) => !d.deleted);
      assert.equal(live.length, 1, "Should have one live event");
      assert.equal(live[0].id, event2.id, "Live event should be the new one");
    });

    it("should accumulate multiple history versions", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 200,
          tags: [],
          content: JSON.stringify({ name: "V1" }),
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "V2" }),
        },
        sk,
      );
      await relay.event(event2);

      const event3 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "V3" }),
        },
        sk,
      );
      await relay.event(event3);

      // Should have 3 documents: current + 2 history
      assert.equal(documents.size, 3, "Should have current + 2 history docs");

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const historyDocs = docs.filter((d) => d.replaced === true);
      const currentDoc = docs.find((d) => !d.replaced);

      assert.equal(historyDocs.length, 2, "Should have 2 history documents");
      assert.equal(currentDoc?.id, event3.id, "Current should be V3");

      const historyIds = historyDocs.map((d) => d.id).sort();
      const expectedIds = [event1.id, event2.id].sort();
      assert.deepEqual(
        historyIds,
        expectedIds,
        "History should contain V1 and V2",
      );
    });

    it("should self-heal stragglers via deep-history sweep", async () => {
      // Simulates a prior cleanup failure: two `replaced: false` docs sit
      // in the same slot when a new replacement arrives. The msearch in
      // Phase 2 hits its size cap (3 hits), which routes the slot through
      // the deep-history fallback (scoped updateByQuery) instead of the
      // fast-path bulk partial-doc update. All older versions should end
      // up marked `replaced: true` after the next event arrives.
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // V1, V2 indexed normally — V1 ends up `replaced: true` after V2.
      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 300,
          tags: [],
          content: JSON.stringify({ name: "V1" }),
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 200,
          tags: [],
          content: JSON.stringify({ name: "V2" }),
        },
        sk,
      );
      await relay.event(event2);

      // Simulate a prior Phase 2 cleanup failure: V1 is *not* marked
      // replaced. Now there are two `replaced: false` docs in the slot.
      const v1Doc = documents.get(event1.id) as Record<string, unknown>;
      v1Doc.replaced = false;

      // V3 arrives. Its Phase 2 msearch will see V1, V2, V3 all with
      // `replaced: false` → hits.length === 3 → deep-history sweep path.
      const event3 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "V3" }),
        },
        sk,
      );
      await relay.event(event3);

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const currentDocs = docs.filter((d) => !d.replaced);
      assert.equal(
        currentDocs.length,
        1,
        "Deep-history sweep should leave exactly one current version",
      );
      assert.equal(
        currentDocs[0].id,
        event3.id,
        "Current version should be V3",
      );

      const historyDocs = docs.filter((d) => d.replaced === true);
      const historyIds = historyDocs.map((d) => d.id).sort();
      const expectedIds = [event1.id, event2.id].sort();
      assert.deepEqual(
        historyIds,
        expectedIds,
        "Both V1 and V2 should be marked replaced after deep-history sweep",
      );
    });

    it("should not overwrite a concurrently-soft-deleted loser", async () => {
      // Simulates a NIP-09 deletion racing the Phase 2 cleanup: the
      // msearch returns a `_source` where `deleted: true`. The bulk
      // partial-doc update path must skip that loser, otherwise it would
      // clobber `deleted` back to false and resurrect the doc.
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "V1" }),
        },
        sk,
      );
      await relay.event(event1);

      // Mark V1 as soft-deleted *before* V2's Phase 2 runs. The mock
      // resolves Phase 2 synchronously (refreshDelayMs: 0), so we have
      // to set this up via direct doc mutation.
      const v1Doc = documents.get(event1.id) as Record<string, unknown>;
      v1Doc.deleted = true;

      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "V2" }),
        },
        sk,
      );
      await relay.event(event2);

      // The msearch for V2's slot filters by `deleted: false`, so V1 is
      // not visible and Phase 2 sees hits.length === 1 → no cleanup.
      // V1's `deleted: true` is preserved.
      const v1After = documents.get(event1.id) as Record<string, unknown>;
      assert.equal(
        v1After.deleted,
        true,
        "V1 should remain soft-deleted after V2's Phase 2 runs",
      );
      assert.notEqual(
        v1After.replaced,
        true,
        "V1 should not have been overwritten with replaced: true",
      );
    });

    it("should auto-include history for naddr-shaped filters (replaceable)", async () => {
      const { client } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      // Query with naddr-shaped filter: 1 kind + 1 author -> includes history
      const results = await relay.query([
        { kinds: [0], authors: [event1.pubkey] },
      ]);

      assert.equal(results.length, 2, "Should return current + history");
      assert.equal(
        results[0].id,
        event2.id,
        "First result should be current (newest)",
      );
      assert.equal(
        results[1].id,
        event1.id,
        "Second result should be history (oldest)",
      );
    });

    it("should auto-include history for naddr-shaped filters (addressable)", async () => {
      const { client } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "slug"]],
          content: "V1",
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "slug"]],
          content: "V2",
        },
        sk,
      );
      await relay.event(event2);

      // Query with naddr-shaped filter: 1 addressable kind + 1 author + 1 #d
      const results = await relay.query([
        { kinds: [30023], authors: [event1.pubkey], "#d": ["slug"] },
      ]);

      assert.equal(results.length, 2, "Should return current + history");
    });

    it("should NOT include history for multi-author filters", async () => {
      const { client } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store events for sk1 with a replacement
      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk1,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk1,
      );
      await relay.event(event2);

      // Store event for sk2
      const event3 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"Bob"}' },
        sk2,
      );
      await relay.event(event3);

      // Query with multi-author filter -> should NOT include history
      const results = await relay.query([
        { kinds: [0], authors: [event1.pubkey, event3.pubkey] },
      ]);

      // Should only get the 2 current versions, not the history
      assert.equal(
        results.length,
        2,
        "Should return only current versions for multi-author query",
      );
    });

    it("should return history docs when queried by ID", async () => {
      const { client } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      // Query for the old event by its ID — should find it even though it's replaced
      const results = await relay.query([{ ids: [event1.id] }]);
      assert.equal(results.length, 1, "Should return the history doc by ID");
      assert.equal(results[0].id, event1.id);
    });

    it("should soft-delete history when removing by coordinate filter (kind 5 a-tag)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create V1 and V2 so there's a history doc
      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete via coordinate filter (as kind 5 with a-tag would produce)
      await relay.remove([{ kinds: [0], authors: [event1.pubkey] }]);

      // Both should be soft-deleted
      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        0,
        "Both current and history should be soft-deleted",
      );
    });

    it("should delete only the targeted event when removing by event ID", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete via event ID filter (as kind 5 with e-tag would produce).
      // This deletes only the specific event, not the entire slot.
      // To delete the whole slot, use an a-tag (coordinate filter).
      await relay.remove([{ ids: [event2.id], authors: [event2.pubkey] }]);

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { deleted?: boolean }
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        1,
        "Only the targeted event should be deleted",
      );
      assert.equal(
        nonDeleted[0].id,
        event1.id,
        "The history event should survive",
      );
    });

    it("should soft-delete history on vanish (kind 62)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create replaceable event history
      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 200, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      // Also create a regular (non-replaceable) event
      const regularEvent = finalizeEvent(
        { kind: 1, created_at: now - 50, tags: [], content: "Hello" },
        sk,
      );
      await relay.event(regularEvent);

      assert.equal(documents.size, 3, "Should have 2 kind-0 docs + 1 kind-1");

      // Vanish: delete all events from this author up to now
      await relay.remove([{ authors: [event1.pubkey], until: now }]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        0,
        "Vanish should soft-delete all events including history",
      );
    });

    it("should spare excluded kinds on remove (NIP-62 gift wraps)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const note = finalizeEvent(
        { kind: 1, created_at: now - 50, tags: [], content: "Hello" },
        sk,
      );
      await relay.event(note);

      // A gift wrap signed by the same key: it belongs to its p-tagged
      // recipient, so a vanish request from the signer must not delete it.
      const wrap = finalizeEvent(
        {
          kind: 1059,
          created_at: now - 40,
          tags: [["p", "f".repeat(64)]],
          content: "sealed",
        },
        sk,
      );
      await relay.event(wrap);

      await relay.remove([{ authors: [note.pubkey], until: now }], {
        excludeKinds: [1059],
      });

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.deepEqual(
        nonDeleted.map((d) => d.id),
        [wrap.id],
        "Only the gift wrap signed by the vanishing key should survive",
      );
    });

    it("should delete the author's own auth-kind events on vanish", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
        authKinds: new Set([4, 1059]),
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // A kind 4 DM the vanishing user wrote. Auth kinds are hidden from
      // catch-all REQ filters, but deletion must still reach them.
      const dm = finalizeEvent(
        {
          kind: 4,
          created_at: now - 30,
          tags: [["p", "f".repeat(64)]],
          content: "ciphertext",
        },
        sk,
      );
      await relay.event(dm);

      await relay.remove([{ authors: [dm.pubkey], until: now }]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      assert.equal(docs.length, 1);
      assert.equal(docs[0].deleted, true, "The author's own DM should be gone");
    });

    it("should delete expired events on vanish", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // NIP-40 expired: invisible to REQ, but still stored, so a vanish
      // request has to reach it.
      const expired = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [["expiration", String(now - 10)]],
          content: "gone by now",
        },
        sk,
      );
      await relay.event(expired);

      await relay.remove([{ authors: [expired.pubkey], until: now }]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      assert.equal(docs.length, 1);
      assert.equal(docs[0].deleted, true, "The expired event should be gone");
    });

    it("should not stop at a client-facing page size on vanish", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      for (let i = 0; i < 150; i++) {
        await relay.event(
          finalizeEvent(
            { kind: 1, created_at: now - i, tags: [], content: `e${i}` },
            sk,
          ),
        );
      }
      const { pubkey } = finalizeEvent(
        { kind: 1, created_at: now, tags: [], content: "x" },
        sk,
      );

      await relay.remove([{ authors: [pubkey], until: now }]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      assert.equal(docs.length, 150);
      assert.equal(
        docs.filter((d) => d.deleted !== true).length,
        0,
        "Every event should be deleted, not just the first page",
      );
    });

    describe("remove with a filter limit", () => {
      /** Three kind 1 events from one key, newest last in the returned array. */
      const seed = async (relay: OpenSearchRelay, sk: Uint8Array) => {
        const now = Math.floor(Date.now() / 1000);
        const events = [];
        for (let i = 0; i < 3; i++) {
          const event = finalizeEvent(
            { kind: 1, created_at: now - 100 + i, tags: [], content: `e${i}` },
            sk,
          );
          await relay.event(event);
          events.push(event);
        }
        return events;
      };

      it("deletes only the newest N matching events", async () => {
        const { client, documents } = createHistoryMockClient();
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();
        const [oldest, middle, newest] = await seed(relay, sk);

        await relay.remove([
          { kinds: [1], authors: [newest.pubkey], limit: 1 },
        ]);

        const deleted = (Array.from(documents.values()) as NostrEvent[])
          .filter((d) => (d as { deleted?: boolean }).deleted === true)
          .map((d) => d.id);
        assert.deepEqual(
          deleted,
          [newest.id],
          "Only the newest event should be deleted",
        );
        assert.ok(!deleted.includes(middle.id));
        assert.ok(!deleted.includes(oldest.id));
      });

      it("deletes nothing and issues no request when the limit is 0", async () => {
        const { client, documents } = createHistoryMockClient();
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();
        const [event] = await seed(relay, sk);

        // Spy after seeding, so only the removal's traffic is counted.
        let requests = 0;
        const { search, updateByQuery } = client;
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        client.search = async (params: any) => {
          requests++;
          return search(params);
        };
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        client.updateByQuery = async (params: any) => {
          requests++;
          return updateByQuery(params);
        };

        await relay.remove([{ kinds: [1], authors: [event.pubkey], limit: 0 }]);

        const docs = Array.from(documents.values()) as Array<
          Record<string, unknown>
        >;
        assert.equal(docs.filter((d) => d.deleted === true).length, 0);
        assert.equal(requests, 0, "limit 0 should not touch OpenSearch at all");
      });

      it("deletes every match when the limit exceeds the match count", async () => {
        const { client, documents } = createHistoryMockClient();
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();
        const [event] = await seed(relay, sk);

        await relay.remove([
          { kinds: [1], authors: [event.pubkey], limit: 100 },
        ]);

        const docs = Array.from(documents.values()) as Array<
          Record<string, unknown>
        >;
        assert.equal(docs.filter((d) => d.deleted !== true).length, 0);
      });

      it("skips excluded kinds while selecting, not after", async () => {
        const { client, documents } = createHistoryMockClient();
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();
        const now = Math.floor(Date.now() / 1000);

        const older = finalizeEvent(
          { kind: 1, created_at: now - 90, tags: [], content: "older" },
          sk,
        );
        await relay.event(older);

        const note = finalizeEvent(
          { kind: 1, created_at: now - 50, tags: [], content: "note" },
          sk,
        );
        await relay.event(note);

        // Newer than the note, but excluded — so `limit: 1` should fall
        // through to the note rather than selecting the wrap and dropping it.
        const wrap = finalizeEvent(
          {
            kind: 1059,
            created_at: now - 10,
            tags: [["p", "f".repeat(64)]],
            content: "sealed",
          },
          sk,
        );
        await relay.event(wrap);

        await relay.remove([{ authors: [note.pubkey], limit: 1 }], {
          excludeKinds: [1059],
        });

        const deleted = (Array.from(documents.values()) as NostrEvent[])
          .filter((d) => (d as { deleted?: boolean }).deleted === true)
          .map((d) => d.id);
        assert.deepEqual(
          deleted,
          [note.id],
          "The newest non-excluded event, and only it, should be deleted",
        );
        assert.ok(!deleted.includes(older.id));
      });
    });

    it("should soft-delete addressable event history when deleting by coordinate", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "my-article"]],
          content: "V1",
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "my-article"]],
          content: "V2",
        },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete via coordinate filter (kind 5 a-tag for addressable event)
      await relay.remove([
        { kinds: [30023], authors: [event1.pubkey], "#d": ["my-article"] },
      ]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        0,
        "Both current and history of addressable event should be deleted",
      );
    });

    it("should delete only the historical event when targeting it by ID (not cascade)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete the historical event by its specific ID.
      // This should only delete V1 (history), not V2 (current).
      await relay.remove([{ ids: [event1.id], authors: [event1.pubkey] }]);

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { deleted?: boolean; replaced?: boolean }
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        1,
        "Only the historical event should be deleted",
      );
      assert.equal(
        nonDeleted[0].id,
        event2.id,
        "Current version should survive",
      );
    });

    it("should not cascade deletion to different d-tag addressable events", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two different addressable event slots
      const article1v1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "article-1"]],
          content: "Article 1 V1",
        },
        sk,
      );
      await relay.event(article1v1);

      const article1v2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "article-1"]],
          content: "Article 1 V2",
        },
        sk,
      );
      await relay.event(article1v2);

      const article2v1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 50,
          tags: [["d", "article-2"]],
          content: "Article 2 V1",
        },
        sk,
      );
      await relay.event(article2v1);

      assert.equal(documents.size, 3, "2 article-1 docs + 1 article-2 doc");

      // Delete article-1 by coordinate — should not affect article-2
      await relay.remove([
        { kinds: [30023], authors: [article1v1.pubkey], "#d": ["article-1"] },
      ]);

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { deleted?: boolean }
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(nonDeleted.length, 1, "Only article-2 should survive");
      assert.equal(
        nonDeleted[0].id,
        article2v1.id,
        "Surviving event should be article-2",
      );
    });

    it("should delete old versions for excluded kinds (default: 30382-30385)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();

      // Kind 30382 is excluded by default
      const v1 = finalizeEvent(
        {
          kind: 30382,
          created_at: 1000,
          content: "record-v1",
          tags: [["d", "target-pubkey"]],
        },
        sk,
      );
      await relay.event(v1);
      assert.equal(documents.size, 1);

      const v2 = finalizeEvent(
        {
          kind: 30382,
          created_at: 2000,
          content: "record-v2",
          tags: [["d", "target-pubkey"]],
        },
        sk,
      );
      await relay.event(v2);

      assert.equal(
        documents.size,
        1,
        "Old version should be deleted, not kept as history",
      );

      const remaining = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      assert.equal(
        remaining[0].id,
        v2.id,
        "Only the newest version should remain",
      );
      assert.equal(
        remaining[0].replaced,
        false,
        "Current version should not be replaced",
      );
    });

    it("should archive old versions for kinds not in the exclude list", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();

      const v1 = finalizeEvent(
        {
          kind: 30023,
          created_at: 1000,
          content: "article-v1",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(v1);

      const v2 = finalizeEvent(
        {
          kind: 30023,
          created_at: 2000,
          content: "article-v2",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(v2);

      assert.equal(documents.size, 2, "Both versions should exist");

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const current = docs.find((d) => d.id === v2.id);
      const archived = docs.find((d) => d.id === v1.id);
      assert.equal(
        current?.replaced,
        false,
        "Current version should not be replaced",
      );
      assert.equal(
        archived?.replaced,
        true,
        "Old version should be marked replaced",
      );
    });

    it("should delete all old versions when history is disabled", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
        historyEnabled: false,
      });

      const sk = generateSecretKey();

      const v1 = finalizeEvent(
        {
          kind: 30023,
          created_at: 1000,
          content: "article-v1",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(v1);

      const v2 = finalizeEvent(
        {
          kind: 30023,
          created_at: 2000,
          content: "article-v2",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(v2);

      assert.equal(
        documents.size,
        1,
        "History disabled: old version should be deleted",
      );
      const remaining = Array.from(documents.values()) as Array<NostrEvent>;
      assert.equal(remaining[0].id, v2.id);
    });

    it("should only archive whitelisted kinds when whitelist is set", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
        historyKindsWhitelist: new Set([30023]),
      });

      const sk = generateSecretKey();

      // Kind 30023 is whitelisted — should archive
      const articleV1 = finalizeEvent(
        {
          kind: 30023,
          created_at: 1000,
          content: "article-v1",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(articleV1);

      const articleV2 = finalizeEvent(
        {
          kind: 30023,
          created_at: 2000,
          content: "article-v2",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(articleV2);

      assert.equal(
        documents.size,
        2,
        "Whitelisted kind 30023: both versions should exist",
      );

      // Kind 0 is NOT whitelisted — should delete old version
      const profileV1 = finalizeEvent(
        { kind: 0, created_at: 1000, content: "{}", tags: [] },
        sk,
      );
      await relay.event(profileV1);
      assert.equal(documents.size, 3);

      const profileV2 = finalizeEvent(
        { kind: 0, created_at: 2000, content: "{}", tags: [] },
        sk,
      );
      await relay.event(profileV2);

      assert.equal(
        documents.size,
        3,
        "Non-whitelisted kind 0: old version should be deleted",
      );

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const profiles = docs.filter((d) => d.kind === 0);
      assert.equal(profiles.length, 1, "Only current profile should remain");
      assert.equal(profiles[0].id, profileV2.id);
    });

    it("should use custom exclude list from config", async () => {
      const { client, documents } = createHistoryMockClient();
      // Exclude kind 30023 (not the default), don't exclude 30382
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
        historyKindsExcluded: new Set([30023]),
      });

      const sk = generateSecretKey();

      // Kind 30023 is now excluded — should delete old version
      const articleV1 = finalizeEvent(
        {
          kind: 30023,
          created_at: 1000,
          content: "article-v1",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(articleV1);

      const articleV2 = finalizeEvent(
        {
          kind: 30023,
          created_at: 2000,
          content: "article-v2",
          tags: [["d", "my-article"]],
        },
        sk,
      );
      await relay.event(articleV2);

      assert.equal(
        documents.size,
        1,
        "Excluded kind 30023: old version should be deleted",
      );

      // Kind 30382 is NOT excluded with this config — should archive
      const recordV1 = finalizeEvent(
        {
          kind: 30382,
          created_at: 1000,
          content: "record-v1",
          tags: [["d", "some-pubkey"]],
        },
        sk,
      );
      await relay.event(recordV1);

      const recordV2 = finalizeEvent(
        {
          kind: 30382,
          created_at: 2000,
          content: "record-v2",
          tags: [["d", "some-pubkey"]],
        },
        sk,
      );
      await relay.event(recordV2);

      assert.equal(
        documents.size,
        3,
        "Non-excluded kind 30382: both versions should exist",
      );
    });

    it("should mark kind 0 pubkey as dirty for score recomputation on replacement", async () => {
      const { client } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const pubkey = getPublicKey(sk);

      const v1 = finalizeEvent(
        { kind: 0, created_at: 1000, content: "{}", tags: [] },
        sk,
      );
      await relay.event(v1);

      const v2 = finalizeEvent(
        { kind: 0, created_at: 2000, content: "{}", tags: [] },
        sk,
      );
      await relay.event(v2);

      // biome-ignore lint/suspicious/noExplicitAny: access private field for testing
      const dirtyPubkeys = (relay as any).pendingDirtyPubkeys as Set<string>;
      assert.ok(
        dirtyPubkeys.has(pubkey),
        "Pubkey should be marked dirty after kind 0 replacement",
      );
    });

    describe("per-filter limit", () => {
      const makeEvents = (n: number, sk: Uint8Array) => {
        const now = Math.floor(Date.now() / 1000);
        const events = [];
        for (let i = 0; i < n; i++) {
          events.push(
            finalizeEvent(
              { kind: 1, created_at: now - i, tags: [], content: `e${i}` },
              sk,
            ),
          );
        }
        return events;
      };

      it("honors the filter's limit verbatim", async () => {
        const { client } = createHistoryMockClient();
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();
        for (const e of makeEvents(20, sk)) await relay.event(e);

        const results = await relay.query([{ kinds: [1], limit: 3 }]);
        assert.equal(results.length, 3, "Should honor the filter limit (3)");
      });

      it("returns everything matching when the filter omits limit", async () => {
        const { client } = createHistoryMockClient();
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const sk = generateSecretKey();
        for (const e of makeEvents(150, sk)) await relay.event(e);

        // No client-facing default lives here — that is the relay's job, so a
        // limitless internal query sees every match.
        const results = await relay.query([{ kinds: [1] }]);
        assert.equal(results.length, 150, "All 150 events should be returned");
      });

      it("bounds the search size by the index result window", async () => {
        let requestedSize: number | undefined;
        const { client } = createHistoryMockClient();
        const search = client.search;
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        client.search = async (params: any) => {
          requestedSize = params.body.size;
          return search(params);
        };
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        await relay.query([{ kinds: [1], limit: 10_000_000 }]);
        assert.equal(requestedSize, OpenSearchRelay.MAX_RESULT_WINDOW);
      });

      it("skips the query entirely when limit is 0", async () => {
        const { client } = createHistoryMockClient();
        let searched = false;
        const search = client.search;
        // biome-ignore lint/suspicious/noExplicitAny: mock accepts any query shape
        client.search = async (params: any) => {
          searched = true;
          return search(params);
        };
        const relay = new OpenSearchRelay(client as unknown as Client, {
          indexName: "test-index",
          bulkMaxSize: 1,
          refreshDelayMs: 0,
        });

        const results = await relay.query([{ kinds: [1], limit: 0 }]);
        assert.equal(results.length, 0);
        assert.ok(!searched, "limit 0 should not hit OpenSearch");
      });
    });
  });

  describe("query-time slot deduplication", () => {
    /**
     * Index a document directly, bypassing `event()`. Phase 2 is what
     * normally marks losing versions `replaced: true`; seeding lets us
     * reproduce the state it leaves behind when it lags, fails, or is
     * dropped under load — two live versions in one slot.
     */
    const seed = (
      documents: Map<string, unknown>,
      event: NostrEvent,
      replaced = false,
    ): NostrEvent => {
      const dTag = event.tags.find(([name]) => name === "d")?.[1];
      documents.set(event.id, {
        ...event,
        deleted: false,
        replaced,
        ...(dTag !== undefined && { tags_map: { d: [dTag] } }),
      });
      return event;
    };

    const mkRelay = () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });
      return { relay, documents };
    };

    const mkArticle = (
      sk: Uint8Array,
      createdAt: number,
      content: string,
    ): NostrEvent =>
      finalizeEvent(
        {
          kind: 30078,
          created_at: createdAt,
          tags: [["d", "app/settings"]],
          content,
        },
        sk,
      );

    it("returns only the newest version of an addressable slot", async () => {
      const { relay, documents } = mkRelay();
      const sk = generateSecretKey();

      seed(documents, mkArticle(sk, 1000, "v1"));
      const newer = seed(documents, mkArticle(sk, 2000, "v2"));

      const results = await relay.query([
        { kinds: [30078], authors: [getPublicKey(sk)] },
      ]);

      assert.equal(results.length, 1, "One version per slot");
      assert.equal(results[0].id, newer.id);
    });

    it("returns only the newest version of a replaceable slot", async () => {
      const { relay, documents } = mkRelay();
      const sk = generateSecretKey();

      const mkProfile = (createdAt: number, name: string): NostrEvent =>
        finalizeEvent(
          {
            kind: 0,
            created_at: createdAt,
            tags: [],
            content: JSON.stringify({ name }),
          },
          sk,
        );

      seed(documents, mkProfile(1000, "Old Alice"));
      const newer = seed(documents, mkProfile(2000, "Alice"));

      const results = await relay.query([{ kinds: [0] }]);

      assert.equal(results.length, 1, "One version per slot");
      assert.equal(results[0].id, newer.id);
    });

    it("breaks a created_at tie by lowest id, not by result order", async () => {
      const { relay, documents } = mkRelay();
      const sk = generateSecretKey();

      const a = mkArticle(sk, 1000, "v1");
      const b = mkArticle(sk, 1000, "v2");
      const [winner, loser] = a.id < b.id ? [a, b] : [b, a];

      // Seed the loser first: the query sorts on `created_at` alone, so a
      // "first hit wins" dedup would keep this one.
      seed(documents, loser);
      seed(documents, winner);

      const results = await relay.query([
        { kinds: [30078], authors: [getPublicKey(sk)] },
      ]);

      assert.equal(results.length, 1, "One version per slot");
      assert.equal(results[0].id, winner.id, "Lowest id should win the tie");
    });

    it("keeps every version for a naddr-shaped history filter", async () => {
      const { relay, documents } = mkRelay();
      const sk = generateSecretKey();

      const older = seed(documents, mkArticle(sk, 1000, "v1"), true);
      const newer = seed(documents, mkArticle(sk, 2000, "v2"));

      const results = await relay.query([
        {
          kinds: [30078],
          authors: [getPublicKey(sk)],
          "#d": ["app/settings"],
        },
      ]);

      const ids = results.map((e) => e.id).sort();
      assert.deepEqual(ids, [older.id, newer.id].sort());
    });

    it("keeps every version for an ids filter", async () => {
      const { relay, documents } = mkRelay();
      const sk = generateSecretKey();

      const older = seed(documents, mkArticle(sk, 1000, "v1"), true);
      const newer = seed(documents, mkArticle(sk, 2000, "v2"));

      const results = await relay.query([{ ids: [older.id, newer.id] }]);

      const ids = results.map((e) => e.id).sort();
      assert.deepEqual(ids, [older.id, newer.id].sort());
    });

    it("leaves regular kinds alone", async () => {
      const { relay, documents } = mkRelay();
      const sk = generateSecretKey();

      const mkNote = (createdAt: number, content: string): NostrEvent =>
        finalizeEvent(
          { kind: 1, created_at: createdAt, tags: [], content },
          sk,
        );

      const first = seed(documents, mkNote(1000, "hello"));
      const second = seed(documents, mkNote(2000, "world"));

      const results = await relay.query([
        { kinds: [1], authors: [getPublicKey(sk)] },
      ]);

      const ids = results.map((e) => e.id).sort();
      assert.deepEqual(
        ids,
        [first.id, second.id].sort(),
        "Regular kinds have no slot and must not be collapsed",
      );
    });
  });

  describe("pendingDirty cap", () => {
    it("MAX_PENDING_DIRTY constant is exposed and has a reasonable value", () => {
      assert.equal(typeof OpenSearchRelay.MAX_PENDING_DIRTY, "number");
      assert.ok(OpenSearchRelay.MAX_PENDING_DIRTY > 0);
    });

    it("addDirtyIds stops adding when the cap is reached", () => {
      const relay = new OpenSearchRelay({} as unknown as Client, {
        indexName: "test",
      });
      // biome-ignore lint/suspicious/noExplicitAny: access private field for testing
      const state = relay as any;

      // Pre-fill the set up to one less than the cap.
      const cap = OpenSearchRelay.MAX_PENDING_DIRTY;
      for (let i = 0; i < cap - 1; i++) {
        state.pendingDirtyIds.add(`id-${i}`);
      }

      // Adding 100 more should only add 1 (filling the cap) and drop the
      // remaining 99.
      const origWarn = console.warn;
      console.warn = () => {};
      try {
        relay.addDirtyIds(Array.from({ length: 100 }, (_, i) => `new-${i}`));
      } finally {
        console.warn = origWarn;
      }

      assert.equal(state.pendingDirtyIds.size, cap);
      // The first of the 100 was added before the cap was hit.
      assert.ok(state.pendingDirtyIds.has("new-0"));
      // The last of the 100 was dropped.
      assert.ok(!state.pendingDirtyIds.has("new-99"));
    });

    it("addDirtyPubkeys stops adding when the cap is reached", () => {
      const relay = new OpenSearchRelay({} as unknown as Client, {
        indexName: "test",
      });
      // biome-ignore lint/suspicious/noExplicitAny: access private field for testing
      const state = relay as any;

      const cap = OpenSearchRelay.MAX_PENDING_DIRTY;
      for (let i = 0; i < cap; i++) {
        state.pendingDirtyPubkeys.add(`pk-${i}`);
      }

      const origWarn = console.warn;
      console.warn = () => {};
      try {
        relay.addDirtyPubkeys(["overflow-a", "overflow-b"]);
      } finally {
        console.warn = origWarn;
      }

      assert.equal(state.pendingDirtyPubkeys.size, cap);
      assert.ok(!state.pendingDirtyPubkeys.has("overflow-a"));
    });

    it("drainDirty clears state and resets overflow warn flag", () => {
      const relay = new OpenSearchRelay({} as unknown as Client, {
        indexName: "test",
      });
      // biome-ignore lint/suspicious/noExplicitAny: access private field for testing
      const state = relay as any;

      state.pendingDirtyIds.add("one");
      state.pendingDirtyPubkeys.add("two");
      state.dirtyOverflowWarned = true;

      const drained = relay.drainDirty();
      assert.deepEqual(drained.ids, ["one"]);
      assert.deepEqual(drained.pubkeys, ["two"]);
      assert.equal(state.pendingDirtyIds.size, 0);
      assert.equal(state.pendingDirtyPubkeys.size, 0);
      assert.equal(state.dirtyOverflowWarned, false);
    });
  });

  describe("NIP-50 sort", () => {
    // Mock client with precomputed score support for sort tests.
    // Score fields are set directly on documents by tests; the mock client
    // simulates OpenSearch sort, script_score, and range filter behaviour.
    const createSortMockClient = () => {
      const documents = new Map<string, unknown>();

      /** Helper: extract the bool.must array from a query (unwrapping script_score). */
      const extractMustClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        // script_score wraps the real query
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: extract the bool.must_not array from a query (unwrapping script_score). */
      const extractMustNotClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must_not as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must_not as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: resolve a dotted field path on a document. */
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const resolveField = (doc: any, field: string): unknown => {
        if (!field.includes(".")) return doc[field];
        return field
          .split(".")
          .reduce(
            (o: Record<string, unknown>, k: string) =>
              o?.[k] as Record<string, unknown>,
            doc,
          );
      };

      /** Helper: check if a document passes all must clauses. */
      const matchesMust = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        clauses: Array<Record<string, unknown>>,
      ): boolean => {
        for (const clause of clauses) {
          if (clause.term) {
            const [field, value] = Object.entries(
              clause.term as Record<string, unknown>,
            )[0];
            if (resolveField(doc, field) !== value) return false;
          }
          if (clause.terms) {
            const [field, values] = Object.entries(
              clause.terms as Record<string, unknown[]>,
            )[0];
            if (!values.includes(resolveField(doc, field) as unknown))
              return false;
          }
          if (clause.range) {
            const [field, bounds] = Object.entries(
              clause.range as Record<string, Record<string, number>>,
            )[0];
            const val = resolveField(doc, field) as number | undefined | null;
            if (val === undefined || val === null) return false;
            if (bounds.gt !== undefined && !(val > bounds.gt)) return false;
            if (bounds.gte !== undefined && !(val >= bounds.gte)) return false;
            if (bounds.lt !== undefined && !(val < bounds.lt)) return false;
            if (bounds.lte !== undefined && !(val <= bounds.lte)) return false;
          }
          if (clause.match) {
            const [field, matchValue] = Object.entries(
              clause.match as Record<string, unknown>,
            )[0];
            const matchQuery =
              typeof matchValue === "object"
                ? (matchValue as { query: string }).query
                : String(matchValue);
            const text = String(resolveField(doc, field) || "").toLowerCase();
            const terms = matchQuery.toLowerCase().split(/\s+/);
            if (!terms.every((t: string) => text.includes(t))) return false;
          }
          // Handle multi_match (search_text / search_text.url)
          if (clause.multi_match) {
            const mm = clause.multi_match as {
              query: string;
              fields: string[];
              operator?: string;
            };
            const queryTerms = mm.query.toLowerCase().split(/\s+/);
            const anyFieldMatches = mm.fields.some((field) => {
              const text = String(resolveField(doc, field) || "").toLowerCase();
              return queryTerms.every((t) => text.includes(t));
            });
            if (!anyFieldMatches) return false;
          }
        }
        return true;
      };

      /** Helper: compute script_score for a document. */
      const computeScriptScore = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        query: Record<string, unknown>,
      ): number | null => {
        if (!query.script_score) return null;
        const script = (
          query.script_score as {
            script: { source: string; params?: Record<string, number> };
          }
        ).script;
        const params = script.params || {};

        // Simple script evaluation for our known scripts
        const src = script.source.replace(/\s+/g, " ").trim();

        if (src.includes("Math.pow(0.5, ageHours / 24.0)")) {
          // sort:hot — uses engagers for non-kind-0, followers for kind-0
          const score = src.includes("followers")
            ? doc.followers || 0
            : doc.engagers || 0;
          const ageHours = (params.now - doc.created_at) / 3600;
          return score * 0.5 ** (ageHours / 24);
        }
        if (src.includes("Math.min(comments, reactions)")) {
          // sort:controversial
          const comments = doc.comment_cnt || 0;
          const reactions = doc.reaction_cnt || 0;
          const balanced = Math.min(comments, reactions);
          return balanced * Math.sqrt(comments + reactions);
        }
        if (src.includes("total / ageHours")) {
          // sort:rising
          const total =
            (doc.comment_cnt || 0) +
            (doc.reaction_cnt || 0) +
            (doc.repost_cnt || 0);
          const ageHours = Math.max((params.now - doc.created_at) / 3600, 0.1);
          return total / ageHours;
        }
        return 0;
      };

      return {
        documents,
        /** Set a score field on a stored document (by event ID). */
        setScore: (
          eventId: string,
          scores: Partial<{
            followers: number;
            engagers: number;
            comment_cnt: number;
            reaction_cnt: number;
            repost_cnt: number;
            zap_amount_msats: number;
          }>,
        ) => {
          for (const [_docId, doc] of documents.entries()) {
            // biome-ignore lint/suspicious/noExplicitAny: test mock
            const d = doc as any;
            if (d.id === eventId) {
              Object.assign(d, scores);
              break;
            }
          }
        },
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const query = body.query as Record<string, unknown>;

            // Handle aggregation queries (used by distinct:author count)
            if (body.aggs) {
              const aggs = body.aggs as Record<string, unknown>;
              if (aggs.unique_authors) {
                const allDocs = Array.from(documents.values());
                const uniquePubkeys = new Set(
                  allDocs
                    .filter((doc) => !(doc as { deleted?: boolean }).deleted)
                    .map((doc) => (doc as NostrEvent).pubkey),
                );
                return {
                  body: {
                    aggregations: {
                      unique_authors: { value: uniquePubkeys.size },
                    },
                    hits: { hits: [] },
                  },
                };
              }
            }

            // Filter documents against the query
            const mustClauses = extractMustClauses(query);
            const mustNotClauses = extractMustNotClauses(query);
            const results: Array<{ _source: unknown; _score?: number }> = [];

            for (const [_id, doc] of documents.entries()) {
              // biome-ignore lint/suspicious/noExplicitAny: test mock
              const d = doc as any;
              if (d.deleted) continue;
              if (!matchesMust(d, mustClauses)) continue;
              // Exclude if doc matches any must_not clause
              if (mustNotClauses.some((c) => matchesMust(d, [c]))) continue;

              const scriptScore = computeScriptScore(d, query);
              results.push({
                _source: doc,
                ...(scriptScore !== null && { _score: scriptScore }),
              });
            }

            // Apply sorting
            const sort = body.sort as
              | Array<Record<string, { order: string }>>
              | undefined;

            if (sort && sort.length > 0) {
              results.sort((a, b) => {
                for (const sortClause of sort) {
                  const [sortField, sortOpts] = Object.entries(sortClause)[0];
                  const desc = (sortOpts as { order: string }).order === "desc";
                  // biome-ignore lint/suspicious/noExplicitAny: test mock
                  const aVal = (a._source as any)[sortField] ?? 0;
                  // biome-ignore lint/suspicious/noExplicitAny: test mock
                  const bVal = (b._source as any)[sortField] ?? 0;
                  if (aVal !== bVal) return desc ? bVal - aVal : aVal - bVal;
                }
                return 0;
              });
            } else if (results.length > 0 && results[0]._score !== undefined) {
              // Sort by script score descending
              results.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
            } else {
              // Default sort by created_at desc
              results.sort((a, b) => {
                const aDoc = a._source as NostrEvent;
                const bDoc = b._source as NostrEvent;
                return bDoc.created_at - aDoc.created_at;
              });
            }

            // Simulate OpenSearch collapse (field collapsing)
            const collapse = body.collapse as { field: string } | undefined;
            if (collapse?.field) {
              const seen = new Set<string>();
              const collapsed: typeof results = [];
              for (const hit of results) {
                const src = hit._source as NostrEvent;
                const val = src[collapse.field as keyof NostrEvent] as string;
                if (!seen.has(val)) {
                  seen.add(val);
                  collapsed.push(hit);
                }
              }
              return { body: { hits: { hits: collapsed } } };
            }

            // Apply size limit
            const size = (body.size as number) ?? results.length;
            return { body: { hits: { hits: results.slice(0, size) } } };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should handle sort:top query", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600,
          tags: [],
          content: "Less popular event",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "More popular event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // Set precomputed scores (event2 has higher engagers)
      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 3 });

      // Query with sort:top
      const results = await relay.query([{ kinds: [1], search: "sort:top" }]);

      // Event2 should be first (higher engagers)
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event1.id);
    });

    it("should reject queries with multiple sort tokens", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Test event",
        },
        sk,
      );

      await relay.event(event);

      // Query with multiple sort tokens should return 0 events
      const results = await relay.query([
        { kinds: [1], search: "sort:top sort:hot" },
      ]);

      assert.equal(results.length, 0);
    });

    it("should handle sort:hot with time decay", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events: one very recent, one older
      const recentEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1800, // 30 minutes ago
          tags: [],
          content: "Recent event",
        },
        sk,
      );

      const olderEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 20 * 3600, // 20 hours ago
          tags: [],
          content: "Older event",
        },
        sk,
      );

      await relay.event(recentEvent);
      await relay.event(olderEvent);

      // Same engagers, but recent event scores higher due to less time decay
      // recent: 5 * 0.5^(0.5/24) ≈ 4.93
      // older:  5 * 0.5^(20/24) ≈ 2.17
      setScore(recentEvent.id, { engagers: 5 });
      setScore(olderEvent.id, { engagers: 5 });

      // Query with sort:hot
      const results = await relay.query([{ kinds: [1], search: "sort:hot" }]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, recentEvent.id);
    });

    it("sort:hot excludes events older than the decay window", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const staleEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 8 * 24 * 3600, // 8 days ago — outside window
          tags: [],
          content: "Stale but heavily engaged event",
        },
        sk,
      );

      const freshEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600, // 1 hour ago
          tags: [],
          content: "Fresh event",
        },
        sk,
      );

      await relay.event(staleEvent);
      await relay.event(freshEvent);

      // Stale event has massive engagement, but decays to ~0 and must be
      // excluded by the created_at window filter (never script-scored).
      setScore(staleEvent.id, { engagers: 100000 });
      setScore(freshEvent.id, { engagers: 1 });

      const results = await relay.query([{ kinds: [1], search: "sort:hot" }]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, freshEvent.id);
    });

    it("sort:hot excludes events with zero engagers", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const unengaged = finalizeEvent(
        {
          kind: 1,
          created_at: now - 60,
          tags: [],
          content: "Nobody engaged with this",
        },
        sk,
      );

      const engaged = finalizeEvent(
        {
          kind: 1,
          created_at: now - 120,
          tags: [],
          content: "Somebody engaged with this",
        },
        sk,
      );

      await relay.event(unengaged);
      await relay.event(engaged);

      // unengaged keeps its default engagers: 0 — filtered out.
      setScore(engaged.id, { engagers: 2 });

      const results = await relay.query([{ kinds: [1], search: "sort:hot" }]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, engaged.id);
    });

    it("sort:controversial excludes events lacking comments or reactions", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const onlyComments = finalizeEvent(
        {
          kind: 1,
          created_at: now - 60,
          tags: [],
          content: "Comments but no reactions",
        },
        sk,
      );

      const balanced = finalizeEvent(
        {
          kind: 1,
          created_at: now - 120,
          tags: [],
          content: "Comments and reactions",
        },
        sk,
      );

      await relay.event(onlyComments);
      await relay.event(balanced);

      // min(comments, reactions) = 0 → score 0 → must be filtered out.
      setScore(onlyComments.id, { comment_cnt: 50, reaction_cnt: 0 });
      setScore(balanced.id, { comment_cnt: 3, reaction_cnt: 3 });

      const results = await relay.query([
        { kinds: [1], search: "sort:controversial" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, balanced.id);
    });

    it("sort:rising excludes events older than the decay window", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const staleEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 8 * 24 * 3600, // 8 days ago — outside window
          tags: [],
          content: "Old event with engagement",
        },
        sk,
      );

      const freshEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1800, // 30 minutes ago
          tags: [],
          content: "Recent event gaining traction",
        },
        sk,
      );

      await relay.event(staleEvent);
      await relay.event(freshEvent);

      setScore(staleEvent.id, { comment_cnt: 100, reaction_cnt: 100 });
      setScore(freshEvent.id, { comment_cnt: 2, reaction_cnt: 2 });

      const results = await relay.query([
        { kinds: [1], search: "sort:rising" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, freshEvent.id);
    });

    it("should combine sort with full-text search", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Bitcoin is great",
        },
        sk,
      );

      await relay.event(event);
      setScore(event.id, { engagers: 1 });

      // Query combining search text and sort
      const results = await relay.query([
        { kinds: [1], search: "bitcoin sort:top" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, event.id);
    });

    it("should return only one event per author with distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events from author 1
      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "First event from author 1",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Second event from author 1",
        },
        sk1,
      );

      // Create one event from author 2
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Event from author 2",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      // Query with distinct:author
      const results = await relay.query([
        { kinds: [1], search: "distinct:author" },
      ]);

      // Should return only 2 events (one per author)
      assert.equal(results.length, 2);

      // Each author should appear exactly once
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);
    });

    it("should combine distinct:author with full-text search", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Bitcoin price analysis",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Bitcoin mining update",
        },
        sk1,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Bitcoin trading strategy",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      // Query combining search text and distinct:author
      const results = await relay.query([
        { kinds: [1], search: "bitcoin distinct:author" },
      ]);

      // Should return only 2 events (one per author)
      assert.equal(results.length, 2);
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);
    });

    it("should combine distinct:author with sort:top", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Author 1: two events, one popular and one not
      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Less popular from author 1",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Popular from author 1",
        },
        sk1,
      );

      // Author 2: one event
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Event from author 2",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      // Set precomputed scores
      setScore(event1b.id, { engagers: 5 });
      setScore(event1a.id, { engagers: 1 });
      setScore(event2.id, { engagers: 3 });

      // Query with sort:top and distinct:author
      const results = await relay.query([
        { kinds: [1], search: "sort:top distinct:author" },
      ]);

      // Should return 2 events (one per author)
      assert.equal(results.length, 2);
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);

      // event1b should be first (highest score from author 1), event2 second
      assert.equal(results[0].id, event1b.id);
      assert.equal(results[1].id, event2.id);
    });

    it("fills the limit with distinct authors on a sorted query", async () => {
      // Regression: distinct:author used to be applied by de-duplicating the
      // response in JS, after OpenSearch had already truncated it to `limit`.
      // If the top `limit` events all shared an author, the query returned far
      // fewer than `limit` events. Collapsing during retrieval fixes it.
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const prolific = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // The three highest-scoring events all belong to one author.
      const hogs = [] as NostrEvent[];
      for (let i = 0; i < 3; i++) {
        const e = finalizeEvent(
          { kind: 1, created_at: now - i, tags: [], content: `hog ${i}` },
          prolific,
        );
        await relay.event(e);
        setScore(e.id, { engagers: 100 - i });
        hogs.push(e);
      }

      const other1 = finalizeEvent(
        { kind: 1, created_at: now - 10, tags: [], content: "other 1" },
        sk2,
      );
      const other2 = finalizeEvent(
        { kind: 1, created_at: now - 11, tags: [], content: "other 2" },
        sk3,
      );
      await relay.event(other1);
      await relay.event(other2);
      setScore(other1.id, { engagers: 5 });
      setScore(other2.id, { engagers: 4 });

      const results = await relay.query([
        { kinds: [1], search: "sort:top distinct:author", limit: 3 },
      ]);

      // One event per author, and the limit is actually filled.
      assert.equal(results.length, 3);
      assert.equal(new Set(results.map((e) => e.pubkey)).size, 3);
      // The prolific author is represented by their highest-scoring event.
      assert.equal(results[0].id, hogs[0].id);
    });

    it("should handle sort:zaps query", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600,
          tags: [],
          content: "Lightly zapped event",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "Heavily zapped event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // Set precomputed zap amounts
      setScore(event1.id, { zap_amount_msats: 1_000_000 });
      setScore(event2.id, { zap_amount_msats: 50_000_000 });

      // Query with sort:zaps
      const results = await relay.query([{ kinds: [1], search: "sort:zaps" }]);

      // Event2 should be first (more sats)
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event1.id);
    });

    it("should include events with no zaps in sort:zaps results, ranked last", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const zappedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "This one got zapped",
        },
        sk,
      );

      const unzappedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "No zaps here",
        },
        sk,
      );

      await relay.event(zappedEvent);
      await relay.event(unzappedEvent);

      // Only one event has zaps
      setScore(zappedEvent.id, { zap_amount_msats: 5_000_000 });

      const results = await relay.query([{ kinds: [1], search: "sort:zaps" }]);

      // Both events are returned; the zapped event ranks first.
      assert.equal(results.length, 2);
      assert.equal(results[0].id, zappedEvent.id);
      assert.equal(results[1].id, unzappedEvent.id);
    });

    it("should still return events when none have zaps", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        { kind: 1, created_at: now - 100, tags: [], content: "No zaps" },
        sk,
      );
      await relay.event(event);

      const results = await relay.query([{ kinds: [1], search: "sort:zaps" }]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, event.id);
    });

    it("should combine distinct:author with sort:zaps", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Author 1: two events, one with low zaps and one with high zaps
      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Author 1 low zaps",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Author 1 high zaps",
        },
        sk1,
      );

      // Author 2: one event with medium zaps
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 75,
          tags: [],
          content: "Author 2 medium zaps",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      setScore(event1a.id, { zap_amount_msats: 100_000 });
      setScore(event1b.id, { zap_amount_msats: 5_000_000 });
      setScore(event2.id, { zap_amount_msats: 3_000_000 });

      // Query with sort:zaps and distinct:author
      const results = await relay.query([
        { kinds: [1], search: "sort:zaps distinct:author" },
      ]);

      // Should return 2 events (one per author)
      assert.equal(results.length, 2);
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);

      // event1b should be first (5M msats, highest for author 1), event2 second (3M msats)
      assert.equal(results[0].id, event1b.id);
      assert.equal(results[1].id, event2.id);
    });

    it("should return all events without distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create multiple events from the same author
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "First event",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Second event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // Query without distinct:author should return all events
      const results = await relay.query([{ kinds: [1] }]);

      assert.equal(results.length, 2);
    });

    it("should count unique authors with distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create multiple events from 3 authors
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now, tags: [], content: "Event 1a" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 10, tags: [], content: "Event 1b" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 20, tags: [], content: "Event 2" },
          sk2,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 30, tags: [], content: "Event 3" },
          sk3,
        ),
      );

      // COUNT with distinct:author should return 3 (unique authors)
      const result = await relay.count([{ search: "distinct:author" }]);
      assert.equal(result.count, 3);
      assert.equal(result.approximate, true);
    });

    it("should count all events without distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now, tags: [], content: "Event 1a" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 10, tags: [], content: "Event 1b" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 20, tags: [], content: "Event 2" },
          sk2,
        ),
      );

      // COUNT without distinct:author should return total events (3)
      const result = await relay.count([{ kinds: [1] }]);
      assert.equal(result.count, 3);
    });

    it("should default to sort:top when search has no extension tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600,
          tags: [],
          content: "hello world",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "hello there",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // event2 has higher engagers
      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 5 });

      // Plain text search with no tokens should use sort:top
      const results = await relay.query([{ kinds: [1], search: "hello" }]);

      // event2 should be first (higher engagers), proving sort:top was applied
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event1.id);
    });

    it("should not default to sort:top when sort:new token is present", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "hello recent",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "hello older",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // event2 has higher engagers, but sort:new should use chronological order
      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 10 });

      // sort:new is a no-op token that prevents the default sort:top
      const results = await relay.query([
        { kinds: [1], search: "hello sort:new" },
      ]);

      // event1 should be first (more recent created_at), proving chronological order
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event1.id);
      assert.equal(results[1].id, event2.id);
    });

    it("should not default to sort:top when search is absent", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "hello recent",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "hello older",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 10 });

      // No search field at all — should use default chronological order
      const results = await relay.query([{ kinds: [1] }]);

      // event1 should be first (more recent), proving chronological order was used
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event1.id);
      assert.equal(results[1].id, event2.id);
    });

    it("should exclude events matching negative search tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "I love nostr and bitcoin",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "I love nostr and ethereum",
        },
        sk,
      );

      const event3 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 300,
          tags: [],
          content: "I love nostr",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);
      await relay.event(event3);

      setScore(event1.id, { engagers: 3 });
      setScore(event2.id, { engagers: 2 });
      setScore(event3.id, { engagers: 1 });

      // Negative token: exclude events containing "bitcoin"
      const results = await relay.query([
        { kinds: [1], search: "nostr -bitcoin sort:new" },
      ]);

      assert.equal(results.length, 2);
      // event1 contains "bitcoin" and should be excluded
      assert.ok(results.every((e) => e.id !== event1.id));
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event3.id);
    });

    it("should support search with only negative tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "bitcoin is great",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "nostr is great",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 1 });

      // Only negative tokens, no positive text
      const results = await relay.query([
        { kinds: [1], search: "-bitcoin sort:new" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, event2.id);
    });

    it("should support multiple negative search tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "bitcoin is great",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "ethereum is great",
        },
        sk,
      );

      const event3 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 300,
          tags: [],
          content: "nostr is great",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);
      await relay.event(event3);

      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 1 });
      setScore(event3.id, { engagers: 1 });

      // Multiple negative tokens
      const results = await relay.query([
        { kinds: [1], search: "-bitcoin -ethereum sort:new" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, event3.id);
    });
  });

  describe("NIP-50 sort: kind 0 (profile) queries", () => {
    // Mock client supporting kind-0 sort queries. Extends the sort mock
    // client with aggregation support for the zaps-by-author query.
    const createKind0SortMockClient = () => {
      const documents = new Map<string, unknown>();

      /** Helper: extract the bool.must array from a query (unwrapping script_score). */
      const extractMustClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: extract the bool.must_not array from a query (unwrapping script_score). */
      const extractMustNotClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must_not as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must_not as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: resolve a dotted field path on a document. */
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const resolveField = (doc: any, field: string): unknown => {
        if (!field.includes(".")) return doc[field];
        return field
          .split(".")
          .reduce(
            (o: Record<string, unknown>, k: string) =>
              o?.[k] as Record<string, unknown>,
            doc,
          );
      };

      /** Helper: check if a document passes all must clauses. */
      const matchesMust = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        clauses: Array<Record<string, unknown>>,
      ): boolean => {
        for (const clause of clauses) {
          if (clause.term) {
            const [field, value] = Object.entries(
              clause.term as Record<string, unknown>,
            )[0];
            if (resolveField(doc, field) !== value) return false;
          }
          if (clause.terms) {
            const [field, values] = Object.entries(
              clause.terms as Record<string, unknown[]>,
            )[0];
            const docVal = resolveField(doc, field);
            // For array fields (like tags_map.p), check if any element matches
            if (Array.isArray(docVal)) {
              if (!docVal.some((v: unknown) => values.includes(v)))
                return false;
            } else {
              if (!values.includes(docVal as unknown)) return false;
            }
          }
          if (clause.range) {
            const [field, bounds] = Object.entries(
              clause.range as Record<string, Record<string, number>>,
            )[0];
            const val = resolveField(doc, field) as number | undefined | null;
            if (val === undefined || val === null) return false;
            if (bounds.gt !== undefined && !(val > bounds.gt)) return false;
            if (bounds.gte !== undefined && !(val >= bounds.gte)) return false;
            if (bounds.lt !== undefined && !(val < bounds.lt)) return false;
            if (bounds.lte !== undefined && !(val <= bounds.lte)) return false;
          }
          if (clause.match) {
            const [field, matchValue] = Object.entries(
              clause.match as Record<string, unknown>,
            )[0];
            const matchQuery =
              typeof matchValue === "object"
                ? (matchValue as { query: string }).query
                : String(matchValue);
            const text = String(resolveField(doc, field) || "").toLowerCase();
            const terms = matchQuery.toLowerCase().split(/\s+/);
            if (!terms.every((t: string) => text.includes(t))) return false;
          }
          // Handle multi_match (search_text / search_text.url)
          if (clause.multi_match) {
            const mm = clause.multi_match as {
              query: string;
              fields: string[];
              operator?: string;
            };
            const queryTerms = mm.query.toLowerCase().split(/\s+/);
            // At least one field must match all terms (prefix/substring match
            // simulates edge-ngram behaviour).
            const anyFieldMatches = mm.fields.some((field) => {
              const text = String(resolveField(doc, field) || "").toLowerCase();
              return queryTerms.every((t) => text.includes(t));
            });
            if (!anyFieldMatches) return false;
          }
        }
        return true;
      };

      /** Helper: compute script_score for a document. */
      const computeScriptScore = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        query: Record<string, unknown>,
      ): number | null => {
        if (!query.script_score) return null;
        const script = (
          query.script_score as {
            script: { source: string; params?: Record<string, number> };
          }
        ).script;
        const params = script.params || {};
        const src = script.source.replace(/\s+/g, " ").trim();

        if (src.includes("Math.pow(0.5, ageHours / 24.0)")) {
          // sort:hot — uses engagers for non-kind-0, followers for kind-0
          const score = src.includes("followers")
            ? doc.followers || 0
            : doc.engagers || 0;
          const ageHours = (params.now - doc.created_at) / 3600;
          return score * 0.5 ** (ageHours / 24);
        }
        if (src.includes("Math.min(comments, reactions)")) {
          const comments = doc.comment_cnt || 0;
          const reactions = doc.reaction_cnt || 0;
          const balanced = Math.min(comments, reactions);
          return balanced * Math.sqrt(comments + reactions);
        }
        if (src.includes("total / ageHours")) {
          const total =
            (doc.comment_cnt || 0) +
            (doc.reaction_cnt || 0) +
            (doc.repost_cnt || 0);
          const ageHours = Math.max((params.now - doc.created_at) / 3600, 0.1);
          return total / ageHours;
        }
        return 0;
      };

      return {
        documents,
        setScore: (
          eventId: string,
          scores: Partial<{
            followers: number;
            engagers: number;
            comment_cnt: number;
            reaction_cnt: number;
            repost_cnt: number;
            zap_amount_msats: number;
          }>,
        ) => {
          for (const [_docId, doc] of documents.entries()) {
            // biome-ignore lint/suspicious/noExplicitAny: test mock
            const d = doc as any;
            if (d.id === eventId) {
              Object.assign(d, scores);
              break;
            }
          }
        },
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const query = body.query as Record<string, unknown>;

            // Handle aggregation queries (zaps-by-author)
            if (body.aggs) {
              const aggs = body.aggs as Record<string, unknown>;
              if (aggs.top_authors) {
                // Simulate terms aggregation on pubkey with sum of zap_amount_msats
                const mustClauses = extractMustClauses(query);
                const pubkeyZaps = new Map<string, number>();

                for (const [_id, doc] of documents.entries()) {
                  // biome-ignore lint/suspicious/noExplicitAny: test mock
                  const d = doc as any;
                  if (d.deleted) continue;
                  if (!matchesMust(d, mustClauses)) continue;
                  const current = pubkeyZaps.get(d.pubkey) ?? 0;
                  pubkeyZaps.set(d.pubkey, current + (d.zap_amount_msats || 0));
                }

                const buckets = [...pubkeyZaps.entries()]
                  .map(([key, total]) => ({
                    key,
                    doc_count: 1,
                    total_zaps: { value: total },
                  }))
                  .sort((a, b) => b.total_zaps.value - a.total_zaps.value);

                return {
                  body: {
                    aggregations: { top_authors: { buckets } },
                    hits: { hits: [] },
                  },
                };
              }
              if (aggs.unique_authors) {
                const allDocs = Array.from(documents.values());
                const uniquePubkeys = new Set(
                  allDocs
                    .filter((doc) => !(doc as { deleted?: boolean }).deleted)
                    .map((doc) => (doc as NostrEvent).pubkey),
                );
                return {
                  body: {
                    aggregations: {
                      unique_authors: { value: uniquePubkeys.size },
                    },
                    hits: { hits: [] },
                  },
                };
              }
            }

            // Filter documents against the query
            const mustClauses = extractMustClauses(query);
            const mustNotClauses = extractMustNotClauses(query);
            const results: Array<{ _source: unknown; _score?: number }> = [];

            for (const [_id, doc] of documents.entries()) {
              // biome-ignore lint/suspicious/noExplicitAny: test mock
              const d = doc as any;
              if (d.deleted) continue;
              if (!matchesMust(d, mustClauses)) continue;
              // Exclude if doc matches any must_not clause
              if (mustNotClauses.some((c) => matchesMust(d, [c]))) continue;

              const scriptScore = computeScriptScore(d, query);
              results.push({
                _source: doc,
                ...(scriptScore !== null && { _score: scriptScore }),
              });
            }

            // Apply sorting
            const sort = body.sort as
              | Array<Record<string, { order: string }>>
              | undefined;

            if (sort && sort.length > 0) {
              results.sort((a, b) => {
                for (const sortClause of sort) {
                  const [sortField, sortOpts] = Object.entries(sortClause)[0];
                  const desc = (sortOpts as { order: string }).order === "desc";
                  // biome-ignore lint/suspicious/noExplicitAny: test mock
                  const aVal = (a._source as any)[sortField] ?? 0;
                  // biome-ignore lint/suspicious/noExplicitAny: test mock
                  const bVal = (b._source as any)[sortField] ?? 0;
                  if (aVal !== bVal) return desc ? bVal - aVal : aVal - bVal;
                }
                return 0;
              });
            } else if (results.length > 0 && results[0]._score !== undefined) {
              results.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
            } else {
              results.sort((a, b) => {
                const aDoc = a._source as NostrEvent;
                const bDoc = b._source as NostrEvent;
                return bDoc.created_at - aDoc.created_at;
              });
            }

            const collapse = body.collapse as { field: string } | undefined;
            if (collapse?.field) {
              const seen = new Set<string>();
              const collapsed: typeof results = [];
              for (const hit of results) {
                const src = hit._source as NostrEvent;
                const val = src[collapse.field as keyof NostrEvent] as string;
                if (!seen.has(val)) {
                  seen.add(val);
                  collapsed.push(hit);
                }
              }
              return { body: { hits: { hits: collapsed } } };
            }

            const size = (body.size as number) ?? results.length;
            return { body: { hits: { hits: results.slice(0, size) } } };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should sort kind 0 by follower count with sort:top", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profile events for 3 users
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "jack" }),
        },
        sk2,
      );

      const profile3 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 20,
          tags: [],
          content: JSON.stringify({ name: "bob" }),
        },
        sk3,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(profile3);

      // Set follower counts (stored as followers for kind 0)
      setScore(profile1.id, { followers: 100 });
      setScore(profile2.id, { followers: 50000 }); // jack is most followed
      setScore(profile3.id, { followers: 500 });

      // Query kind 0 with sort:top
      const results = await relay.query([{ kinds: [0], search: "sort:top" }]);

      assert.equal(results.length, 3);
      assert.equal(results[0].id, profile2.id); // jack (50000 followers)
      assert.equal(results[1].id, profile3.id); // bob (500 followers)
      assert.equal(results[2].id, profile1.id); // alice (100 followers)
    });

    it("should combine sort:top with text search for account autocomplete", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "jack" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "jackson" }),
        },
        sk2,
      );

      const profile3 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 20,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk3,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(profile3);

      setScore(profile1.id, { followers: 50000 }); // jack — most followed
      setScore(profile2.id, { followers: 200 }); // jackson — fewer
      setScore(profile3.id, { followers: 1000 }); // alice — irrelevant to search

      // Search for "jac" with sort:top — should find jack and jackson
      const results = await relay.query([
        { kinds: [0], search: "jac sort:top" },
      ]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // jack (most followed)
      assert.equal(results[1].id, profile2.id); // jackson
    });

    it("should still default to sort:top when only the autocomplete token is present", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // profile1 (jack) is older but has far more followers. If the
      // autocomplete token suppressed the sort:top default, we'd fall back
      // to created_at desc and profile2 (jackson) would sort first.
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "jack" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "jackson" }),
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);

      setScore(profile1.id, { followers: 50000 }); // jack — most followed
      setScore(profile2.id, { followers: 200 }); // jackson — newer, fewer

      const results = await relay.query([
        { kinds: [0], search: "jac autocomplete:true" },
      ]);

      // Follower-ranked order proves sort:top was applied despite the
      // autocomplete:true extension token being present.
      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // jack (most followers)
      assert.equal(results[1].id, profile2.id); // jackson
    });

    it("should sort kind 0 by controversial (two-step author lookup)", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profiles
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "controversial_alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "tame_bob" }),
        },
        sk2,
      );

      // Create kind 1 events (posts) that will have controversy scores
      const post1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Controversial post by alice",
        },
        sk1,
      );

      const post2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "Tame post by bob",
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(post1);
      await relay.event(post2);

      // Set controversy scores on posts
      // controversial = min(comment, reaction) * sqrt(total)
      // post1: min(10, 8) * sqrt(18) = 8 * 4.24 = 33.9
      setScore(post1.id, { comment_cnt: 10, reaction_cnt: 8 });
      // post2: min(2, 1) * sqrt(3) = 1 * 1.73 = 1.73
      setScore(post2.id, { comment_cnt: 2, reaction_cnt: 1 });

      // Query kind 0 with sort:controversial
      const results = await relay.query([
        { kinds: [0], search: "sort:controversial" },
      ]);

      // Should return profiles ordered by their posts' controversy
      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // alice (more controversial)
      assert.equal(results[1].id, profile2.id); // bob
    });

    it("should sort kind 0 by rising (two-step author lookup)", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profiles
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "trending_alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "steady_bob" }),
        },
        sk2,
      );

      // Create recent posts
      const post1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1800, // 30 min ago — very recent
          tags: [],
          content: "Viral post by alice",
        },
        sk1,
      );

      const post2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10 * 3600, // 10 hours ago
          tags: [],
          content: "Older post by bob",
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(post1);
      await relay.event(post2);

      // rising = (comment + reaction + repost) / age_hours
      // post1: (5 + 5 + 5) / 0.5 = 30
      setScore(post1.id, {
        engagers: 1,
        comment_cnt: 5,
        reaction_cnt: 5,
        repost_cnt: 5,
      });
      // post2: (5 + 5 + 5) / 10 = 1.5
      setScore(post2.id, {
        engagers: 1,
        comment_cnt: 5,
        reaction_cnt: 5,
        repost_cnt: 5,
      });

      const results = await relay.query([
        { kinds: [0], search: "sort:rising" },
      ]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // alice (rising faster)
      assert.equal(results[1].id, profile2.id); // bob
    });

    it("should sort kind 0 by total zaps received across all events", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profiles
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "zap_queen_alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "modest_bob" }),
        },
        sk2,
      );

      // Create posts that received zaps
      const post1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Alice post 1",
        },
        sk1,
      );

      const post1b = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "Alice post 2",
        },
        sk1,
      );

      const post2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 300,
          tags: [],
          content: "Bob post 1",
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(post1a);
      await relay.event(post1b);
      await relay.event(post2);

      // Set zap amounts on posts
      setScore(post1a.id, { zap_amount_msats: 10_000_000 }); // 10k sats
      setScore(post1b.id, { zap_amount_msats: 5_000_000 }); // 5k sats
      // Alice total: 15k sats
      setScore(post2.id, { zap_amount_msats: 3_000_000 }); // 3k sats
      // Bob total: 3k sats

      const results = await relay.query([{ kinds: [0], search: "sort:zaps" }]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // alice (15k sats total)
      assert.equal(results[1].id, profile2.id); // bob (3k sats)
    });

    it("should return empty when no authors have zaps for sort:zaps kind 0", async () => {
      const { client } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      await relay.event(
        finalizeEvent(
          {
            kind: 0,
            created_at: now,
            tags: [],
            content: JSON.stringify({ name: "no_zaps" }),
          },
          sk,
        ),
      );

      const results = await relay.query([{ kinds: [0], search: "sort:zaps" }]);

      assert.equal(results.length, 0);
    });

    it("should not use kind-0 sort for multi-kind queries", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk,
      );

      const post = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "A popular post",
        },
        sk,
      );

      await relay.event(profile);
      await relay.event(post);

      setScore(post.id, { engagers: 10 });

      // Query with kinds [0, 1] — should use regular sort, not kind-0 sort
      const results = await relay.query([
        { kinds: [0, 1], search: "sort:top" },
      ]);

      // Multi-kind query uses the regular sort path (by engagers), so the
      // post (engagers: 10) ranks ahead of the profile (engagers: 0).
      assert.equal(results.length, 2);
      assert.equal(results[0].id, post.id);
      assert.equal(results[1].id, profile.id);
    });

    it("should match kind 0 profiles by partial name prefix", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "jack" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "jackson" }),
        },
        sk2,
      );

      const profile3 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 20,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk3,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(profile3);

      setScore(profile1.id, { followers: 50000 });
      setScore(profile2.id, { followers: 200 });
      setScore(profile3.id, { followers: 1000 });

      // "jac" is a prefix — should match "jack" and "jackson" but not "alice"
      const results = await relay.query([{ kinds: [0], search: "jac" }]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // jack (most followers)
      assert.equal(results[1].id, profile2.id); // jackson
    });

    it("should match kind 0 profiles by display_name prefix", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: "jack",
            display_name: "Jack Dorsey",
          }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({
            name: "alice",
            display_name: "Alice Wonderland",
          }),
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);

      setScore(profile1.id, { followers: 100 });
      setScore(profile2.id, { followers: 100 });

      // Search by display_name prefix "dor" should match Jack Dorsey
      const results = await relay.query([{ kinds: [0], search: "dor" }]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, profile1.id);
    });

    it("should match non-kind-0 searches via search_text", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Kind 1 event with "jack" in content
      const post = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Hello from jack",
        },
        sk,
      );

      await relay.event(post);
      setScore(post.id, { engagers: 10 });

      // Kind 1 search matches via search_text built from content
      const results = await relay.query([{ kinds: [1], search: "jack" }]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, post.id);
    });

    it("should opt out of autocomplete via autocomplete:false for kind 0", async () => {
      // Capture the OpenSearch query body to verify the field routing
      // rather than rely on the mock's substring matching.
      let capturedQuery: Record<string, unknown> | undefined;
      const client = {
        bulk: async () => ({ body: { errors: false, items: [] } }),
        mget: async () => ({ body: { docs: [] } }),
        msearch: async (requests: unknown[]) => ({
          body: {
            responses: requests.map(() => ({ hits: { hits: [] } })),
          },
        }),
        search: async ({ body }: { body: Record<string, unknown> }) => {
          capturedQuery = body.query as Record<string, unknown>;
          return { body: { hits: { hits: [], total: { value: 0 } } } };
        },
        count: async () => ({ body: { count: 0 } }),
        indices: {
          exists: async () => ({ body: true }),
          create: async () => ({ body: {} }),
        },
        close: async () => {},
      };
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      await relay.query([{ kinds: [0], search: "jac autocomplete:false" }]);

      // The must clauses should include a multi_match against search_text,
      // NOT a match against autocomplete_text.
      const must =
        ((capturedQuery?.bool as Record<string, unknown>)?.must as Array<
          Record<string, unknown>
        >) || [];
      const hasSearchTextMultiMatch = must.some((clause) => {
        const mm = clause.multi_match as { fields?: string[] } | undefined;
        return mm?.fields?.includes("search_text");
      });
      const hasAutocompleteMatch = must.some(
        (clause) =>
          (clause.match as Record<string, unknown> | undefined)
            ?.autocomplete_text !== undefined,
      );
      assert.equal(hasSearchTextMultiMatch, true);
      assert.equal(hasAutocompleteMatch, false);
    });

    it("should opt in to autocomplete via autocomplete:true for non-kind-0", async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      const client = {
        bulk: async () => ({ body: { errors: false, items: [] } }),
        mget: async () => ({ body: { docs: [] } }),
        msearch: async (requests: unknown[]) => ({
          body: {
            responses: requests.map(() => ({ hits: { hits: [] } })),
          },
        }),
        search: async ({ body }: { body: Record<string, unknown> }) => {
          capturedQuery = body.query as Record<string, unknown>;
          return { body: { hits: { hits: [], total: { value: 0 } } } };
        },
        count: async () => ({ body: { count: 0 } }),
        indices: {
          exists: async () => ({ body: true }),
          create: async () => ({ body: {} }),
        },
        close: async () => {},
      };
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      await relay.query([{ kinds: [40], search: "gen autocomplete:true" }]);

      const must =
        ((capturedQuery?.bool as Record<string, unknown>)?.must as Array<
          Record<string, unknown>
        >) || [];
      const hasAutocompleteMatch = must.some(
        (clause) =>
          (clause.match as Record<string, unknown> | undefined)
            ?.autocomplete_text !== undefined,
      );
      const hasSearchTextMultiMatch = must.some((clause) => {
        const mm = clause.multi_match as { fields?: string[] } | undefined;
        return mm?.fields?.includes("search_text");
      });
      assert.equal(hasAutocompleteMatch, true);
      assert.equal(hasSearchTextMultiMatch, false);
    });

    it("should match nothing when autocomplete:true targets a kind with no autocomplete_text", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Kind 1 short text note with no autocomplete-shaped tags. The
      // buildAutocompleteText function produces an empty string for this
      // event, so the field is not indexed.
      const post = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Hello from jack",
        },
        sk,
      );

      await relay.event(post);
      setScore(post.id, { engagers: 10 });

      // autocomplete:true against a kind with no field → no matches.
      const results = await relay.query([
        { kinds: [1], search: "jac autocomplete:true" },
      ]);
      assert.equal(results.length, 0);
    });

    it("should match tag-derived autocomplete_text via the title tag", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Long-form article whose title is "Football and Friends".
      const article = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [
            ["d", "my-article"],
            ["title", "Football and Friends"],
          ],
          content: "article body",
        },
        sk,
      );

      await relay.event(article);
      setScore(article.id, { engagers: 5 });

      const results = await relay.query([
        { kinds: [30023], search: "foot autocomplete:true" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, article.id);
    });

    it("should match nip05 via autocomplete on kind 0", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: "alice",
            nip05: "alice@example.com",
          }),
        },
        sk,
      );

      await relay.event(profile);
      setScore(profile.id, { followers: 100 });

      // Prefix of the nip05 should match via autocomplete_text.
      const results = await relay.query([{ kinds: [0], search: "alice@ex" }]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, profile.id);
    });
  });

  describe("buildTagsMap validation", () => {
    const createMockClient = () => {
      const documents = new Map<string, unknown>();
      return {
        documents,
        client: {
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as { index?: { _id: string } };
              const payload = body[i + 1] as Record<string, unknown>;
              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              }
            }
            return { body: { errors: false, items } };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    /** Helper to store an event and return its tags_map from the mock. */
    const getTagsMap = async (
      tags: string[][],
      opts?: { tagValueMaxCountPerName?: number; kind?: number },
    ): Promise<Record<string, string[]>> => {
      const { client, documents } = createMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
        tagValueMaxCountPerName: opts?.tagValueMaxCountPerName,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: opts?.kind ?? 1,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: "",
        },
        sk,
      );

      await relay.event(event);

      const doc = Array.from(documents.values())[0] as {
        tags_map: Record<string, string[]>;
      };
      return doc.tags_map;
    };

    it("should include single-letter tag names", async () => {
      const tagsMap = await getTagsMap([
        ["e", "abc123"],
        ["p", "def456"],
        ["t", "bitcoin"],
      ]);

      assert.deepEqual(tagsMap.e, ["abc123"]);
      assert.deepEqual(tagsMap.p, ["def456"]);
      assert.deepEqual(tagsMap.t, ["bitcoin"]);
    });

    it("should allow whitelisted multi-letter tag names", async () => {
      const tagsMap = await getTagsMap([
        ["expiration", "1700000000"],
        ["goal", "abc123def456"],
        ["proxy", "https://example.com/objects/123"],
        ["status", "live"],
      ]);

      assert.deepEqual(tagsMap.expiration, ["1700000000"]);
      assert.deepEqual(tagsMap.goal, ["abc123def456"]);
      assert.deepEqual(tagsMap.proxy, ["https://example.com/objects/123"]);
      assert.deepEqual(tagsMap.status, ["live"]);
    });

    it("should allow special single-character tag names", async () => {
      const tagsMap = await getTagsMap([
        ["-", ""],
        ["_", "value"],
      ]);

      assert.deepEqual(tagsMap["-"], [""]);
      assert.deepEqual(tagsMap._, ["value"]);
    });

    it("should index content-warning tags (NIP-36)", async () => {
      const tagsMap = await getTagsMap([["content-warning", "nudity"]]);

      assert.deepEqual(tagsMap["content-warning"], ["nudity"]);
    });

    it("should index value-less marker tags with an empty string", async () => {
      const tagsMap = await getTagsMap([["content-warning"], ["-"]]);

      assert.deepEqual(tagsMap["content-warning"], [""]);
      assert.deepEqual(tagsMap["-"], [""]);
    });

    it("should reject value-less tags with non-whitelisted names", async () => {
      const tagsMap = await getTagsMap([["bolt11"], ["t", "keep"]]);

      assert.equal(tagsMap.bolt11, undefined);
      assert.deepEqual(tagsMap.t, ["keep"]);
    });

    it("should reject multi-letter tag names not in whitelist", async () => {
      const tagsMap = await getTagsMap([
        ["t", "keep"],
        ["bolt11", "lnbc..."],
        ["imeta", "url https://example.com"],
        ["relays", "wss://relay.example.com"],
        ["nonce", "12345"],
        ["my_custom_tag", "value"],
        // Previously allowed, now rejected (free-form text / URLs / niche):
        ["alt", "reply"],
        ["title", "Hello World"],
        ["image", "https://example.com/pic.jpg"],
        ["name", "My Thing"],
      ]);

      assert.deepEqual(tagsMap.t, ["keep"]);
      assert.equal(tagsMap.bolt11, undefined);
      assert.equal(tagsMap.imeta, undefined);
      assert.equal(tagsMap.relays, undefined);
      assert.equal(tagsMap.nonce, undefined);
      assert.equal(tagsMap.my_custom_tag, undefined);
      assert.equal(tagsMap.alt, undefined);
      assert.equal(tagsMap.title, undefined);
      assert.equal(tagsMap.image, undefined);
      assert.equal(tagsMap.name, undefined);
    });

    it("should accept tag values up to 255 characters", async () => {
      const value255 = "x".repeat(255);
      const tagsMap = await getTagsMap([["t", value255]]);

      assert.deepEqual(tagsMap.t, [value255]);
    });

    it("should reject tag values exceeding 255 characters", async () => {
      const value256 = "x".repeat(256);
      const tagsMap = await getTagsMap([["t", value256]]);

      assert.deepEqual(tagsMap.t, []);
    });

    it("should keep valid values and skip invalid values for the same tag", async () => {
      const longValue = "x".repeat(300);
      const tagsMap = await getTagsMap([
        ["t", "bitcoin"],
        ["t", longValue],
        ["t", "nostr"],
      ]);

      assert.deepEqual(tagsMap.t, ["bitcoin", "nostr"]);
    });

    it("should create the key with an empty array when all values are too long", async () => {
      const longValue1 = "x".repeat(256);
      const longValue2 = "y".repeat(500);
      const tagsMap = await getTagsMap([
        ["t", longValue1],
        ["t", longValue2],
      ]);

      assert.ok("t" in tagsMap);
      assert.deepEqual(tagsMap.t, []);
    });

    it("should not create a key for non-whitelisted multi-letter tag names", async () => {
      const tagsMap = await getTagsMap([
        ["invalid.name", "good-value"],
        ["another_bad", "also-good"],
      ]);

      assert.equal(Object.keys(tagsMap).length, 0);
    });

    it("should handle empty tags array", async () => {
      const tagsMap = await getTagsMap([]);
      assert.deepEqual(tagsMap, {});
    });

    it("should index value-less tags as markers and skip empty tags", async () => {
      const tagsMap = await getTagsMap([[], ["e"], ["p", "value"]]);

      assert.deepEqual(tagsMap.e, [""]);
      assert.deepEqual(tagsMap.p, ["value"]);
    });

    it("should cap values per tag name at the configured tagValueMaxCountPerName", async () => {
      const cap = 10;
      // Build 2*cap p-tags, each with a unique value.
      const tags = Array.from({ length: cap * 2 }, (_, i) => [
        "p",
        `${i}`.padStart(64, "0"),
      ]);
      const tagsMap = await getTagsMap(tags, { tagValueMaxCountPerName: cap });

      assert.equal(tagsMap.p.length, cap);
      // The first `cap` values should be kept (in-order).
      assert.equal(tagsMap.p[0], "0".repeat(64));
      assert.equal(tagsMap.p[cap - 1], `${cap - 1}`.padStart(64, "0"));
      // The (cap+1)-th value should have been dropped.
      assert.ok(!tagsMap.p.includes(`${cap}`.padStart(64, "0")));
    });

    it("per-tag-name cap applies independently to each tag name", async () => {
      const cap = 10;
      const tags: string[][] = [];
      for (let i = 0; i < cap + 10; i++) {
        tags.push(["e", `e-${i}`.padStart(64, "0")]);
        tags.push(["p", `p-${i}`.padStart(64, "0")]);
      }
      const tagsMap = await getTagsMap(tags, { tagValueMaxCountPerName: cap });
      // Each tag name is independently capped.
      assert.equal(tagsMap.e.length, cap);
      assert.equal(tagsMap.p.length, cap);
    });

    it("kind 7: last e tag is preserved even when earlier e-tags were dropped by cap", async () => {
      // Build a kind 7 event with more e-tags than the cap. The last one
      // (the true reaction target per NIP-25) must survive even though
      // earlier e-tags filled the bucket first.
      const cap = 10;
      const tags: string[][] = [];
      for (let i = 0; i < cap + 5; i++) {
        tags.push(["e", `filler-${i}`.padStart(64, "0")]);
      }
      const targetId = "ff".repeat(32);
      tags.push(["e", targetId]);

      const tagsMap = await getTagsMap(tags, {
        tagValueMaxCountPerName: cap,
        kind: 7,
      });

      // NIP-25: only the last e tag should be indexed.
      assert.deepEqual(tagsMap.e, [targetId]);
    });

    it("default cap is TAG_VALUE_MAX_COUNT_PER_NAME (5000) — kind-3 contact lists index fully", async () => {
      // A kind-3 contact list with 2000 p-tags must be fully projected into
      // tags_map.p with the default cap, otherwise follower counts and
      // NIP-85 stats would be wrong. The cap is also advertised as NIP-11
      // `limitation.max_event_tags`.
      assert.equal(OpenSearchRelay.TAG_VALUE_MAX_COUNT_PER_NAME, 5000);
      const tags = Array.from({ length: 2000 }, (_, i) => [
        "p",
        `${i}`.padStart(64, "0"),
      ]);
      const tagsMap = await getTagsMap(tags, { kind: 3 });
      assert.equal(tagsMap.p.length, 2000);
    });
  });

  describe("NIP-48 protocol filter (NIP-50 extension)", () => {
    // Mock client with protocol field support
    const createProtocolMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryMust = (
              (body.query as Record<string, unknown>)?.bool as Record<
                string,
                unknown
              >
            )?.must as Array<Record<string, unknown>> | undefined;

            // Extract protocol filter if present
            let protocolFilter: string | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.protocol) {
                protocolFilter = (clause.term as Record<string, unknown>)
                  .protocol as string;
              }
            }

            // Extract must_not clauses
            const queryMustNot = (
              (body.query as Record<string, unknown>)?.bool as Record<
                string,
                unknown
              >
            )?.must_not as Array<Record<string, unknown>> | undefined;

            // Check if protocol existence is negated (protocol:false)
            let excludeProtocol = false;
            for (const clause of queryMustNot || []) {
              if (
                (clause.exists as Record<string, unknown>)?.field === "protocol"
              ) {
                excludeProtocol = true;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                protocol?: string;
              };

              // Skip deleted events
              if (docTyped.deleted) {
                continue;
              }

              // Filter by protocol if specified
              if (protocolFilter && docTyped.protocol !== protocolFilter) {
                continue;
              }

              // Exclude events with protocol if protocol:false
              if (excludeProtocol && docTyped.protocol) {
                continue;
              }

              results.push({ _source: doc });
            }

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should extract protocol from proxy tag", async () => {
      const { client } = createProtocolMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "proxy",
              "https://gleasonator.com/objects/8f6fac53-4f66-4c6e-ac7d-92e5e78c3e79",
              "activitypub",
            ],
          ],
          content: "I'm vegan btw",
        },
        sk,
      );

      await relay.event(event);

      // Verify the document was stored with protocol field
      const results = await relay.query([{ kinds: [1] }]);
      assert.equal(results.length, 1);
    });

    it("should filter by protocol using search extension", async () => {
      const { client } = createProtocolMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with activitypub protocol
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "proxy",
              "https://gleasonator.com/objects/8f6fac53-4f66-4c6e-ac7d-92e5e78c3e79",
              "activitypub",
            ],
          ],
          content: "From ActivityPub",
        },
        sk,
      );

      // Event with atproto protocol
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [
            [
              "proxy",
              "at://did:plc:zhbjlbmir5dganqhueg7y4i3/app.bsky.feed.post/3jt5hlibeol2i",
              "atproto",
            ],
          ],
          content: "From ATProto",
        },
        sk,
      );

      // Event with no protocol
      const event3 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 20,
          tags: [],
          content: "Native Nostr event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);
      await relay.event(event3);

      // Filter by activitypub protocol
      const results1 = await relay.query([
        { kinds: [1], search: "protocol:activitypub" },
      ]);
      assert.equal(results1.length, 1);
      assert.equal(results1[0].id, event1.id);

      // Filter by atproto protocol
      const results2 = await relay.query([
        { kinds: [1], search: "protocol:atproto" },
      ]);
      assert.equal(results2.length, 1);
      assert.equal(results2[0].id, event2.id);

      // Query without protocol filter should return all events
      const resultsAll = await relay.query([{ kinds: [1] }]);
      assert.equal(resultsAll.length, 3);
    });

    it("should return only native events with protocol:nostr", async () => {
      const { client } = createProtocolMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with activitypub protocol
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "proxy",
              "https://gleasonator.com/objects/8f6fac53-4f66-4c6e-ac7d-92e5e78c3e79",
              "activitypub",
            ],
          ],
          content: "From ActivityPub",
        },
        sk,
      );

      // Event with atproto protocol
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [
            [
              "proxy",
              "at://did:plc:zhbjlbmir5dganqhueg7y4i3/app.bsky.feed.post/3jt5hlibeol2i",
              "atproto",
            ],
          ],
          content: "From ATProto",
        },
        sk,
      );

      // Native Nostr event (no protocol)
      const event3 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 20,
          tags: [],
          content: "Native Nostr event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);
      await relay.event(event3);

      // protocol:nostr should return only native events (no protocol)
      const results = await relay.query([
        { kinds: [1], search: "protocol:nostr" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, event3.id);
    });

    it("should handle events with multiple proxy tags correctly", async () => {
      const { client } = createProtocolMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with multiple proxy tags (should use first one)
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "proxy",
              "https://gleasonator.com/objects/8f6fac53-4f66-4c6e-ac7d-92e5e78c3e79",
              "activitypub",
            ],
            ["proxy", "https://example.com/other", "web"],
          ],
          content: "Event with multiple proxy tags",
        },
        sk,
      );

      await relay.event(event);

      // Should filter by the first proxy tag's protocol
      const results = await relay.query([
        { kinds: [1], search: "protocol:activitypub" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, event.id);
    });
  });

  describe("NIP-89 client address filter (NIP-50 extension)", () => {
    // Mock client with client address field support
    const createClientMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryMust = (
              (body.query as Record<string, unknown>)?.bool as Record<
                string,
                unknown
              >
            )?.must as Array<Record<string, unknown>> | undefined;

            // Extract client filter if present
            let clientFilter: string | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.client) {
                clientFilter = (clause.term as Record<string, unknown>)
                  .client as string;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                client?: string;
              };

              if (docTyped.deleted) continue;

              if (clientFilter && docTyped.client !== clientFilter) continue;

              results.push({ _source: doc });
            }

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    const dittoAddress =
      "31990:781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5:ditto";

    it("should index the client address from the client tag's third value", async () => {
      const { client, documents } = createClientMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["client", "Ditto", dittoAddress, "wss://relay.example.com/"]],
          content: "posted from Ditto",
        },
        sk,
      );

      await relay.event(event);

      const doc = documents.get(event.id) as { client?: string };
      assert.equal(doc.client, dittoAddress);
    });

    it("should not set client when the client tag has no third value", async () => {
      const { client, documents } = createClientMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["client", "Ditto"]],
          content: "client name only",
        },
        sk,
      );

      await relay.event(event);

      const doc = documents.get(event.id) as { client?: string };
      assert.equal(doc.client, undefined);
    });

    it("should filter events by client address using search extension", async () => {
      const { client } = createClientMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const dittoEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["client", "Ditto", dittoAddress]],
          content: "from Ditto",
        },
        sk,
      );

      const otherAddress = "31990:abc:other";
      const otherEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [["client", "Other", otherAddress]],
          content: "from Other",
        },
        sk,
      );

      const nativeEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 20,
          tags: [],
          content: "no client tag",
        },
        sk,
      );

      await relay.event(dittoEvent);
      await relay.event(otherEvent);
      await relay.event(nativeEvent);

      // Filter by the Ditto client address
      const dittoResults = await relay.query([
        { kinds: [1], search: `client:${dittoAddress}` },
      ]);
      assert.equal(dittoResults.length, 1);
      assert.equal(dittoResults[0].id, dittoEvent.id);

      // Filter by the other client address
      const otherResults = await relay.query([
        { kinds: [1], search: `client:${otherAddress}` },
      ]);
      assert.equal(otherResults.length, 1);
      assert.equal(otherResults[0].id, otherEvent.id);

      // Query without a client filter returns all events
      const all = await relay.query([{ kinds: [1] }]);
      assert.equal(all.length, 3);
    });
  });

  describe("NIP-50 language filter", () => {
    // Mock client with language field support
    const createLanguageMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryMust = (
              (body.query as Record<string, unknown>)?.bool as Record<
                string,
                unknown
              >
            )?.must as Array<Record<string, unknown>> | undefined;

            // Extract language filter if present
            let languageFilter: string | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.language) {
                languageFilter = (clause.term as Record<string, unknown>)
                  .language as string;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                language?: string;
              };

              if (docTyped.deleted) continue;
              if (languageFilter && docTyped.language !== languageFilter)
                continue;

              results.push({ _source: doc });
            }

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should store language on indexed documents when passed via analysis", async () => {
      const { client, documents } = createLanguageMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content:
            "This is a long enough English sentence for language detection to work properly",
        },
        sk,
      );

      await relay.event(event, { analysis: { language: "en" } });

      const doc = Array.from(documents.values())[0] as {
        language?: string;
      };
      assert.equal(doc.language, "en");
    });

    it("should filter events by language using search extension", async () => {
      const { client } = createLanguageMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // English event
      const enEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content:
            "This is a perfectly normal English language post about Nostr",
        },
        sk,
      );

      // Chinese event
      const zhEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [],
          content: "这是一个关于比特币和闪电网络的中文帖子",
        },
        sk,
      );

      await relay.event(enEvent, { analysis: { language: "en" } });
      await relay.event(zhEvent, { analysis: { language: "zh" } });

      // Filter by English
      const enResults = await relay.query([
        { kinds: [1], search: "language:en" },
      ]);
      assert.equal(enResults.length, 1);
      assert.equal(enResults[0].id, enEvent.id);

      // Filter by Chinese
      const zhResults = await relay.query([
        { kinds: [1], search: "language:zh" },
      ]);
      assert.equal(zhResults.length, 1);
      assert.equal(zhResults[0].id, zhEvent.id);
    });

    it("should return all events when no language filter is applied", async () => {
      const { client } = createLanguageMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      await relay.event(
        finalizeEvent(
          {
            kind: 1,
            created_at: now,
            tags: [],
            content: "An English post about the state of the world today",
          },
          sk,
        ),
      );

      await relay.event(
        finalizeEvent(
          {
            kind: 1,
            created_at: now - 10,
            tags: [],
            content: "これは日本語の投稿です。言語フィルタのテストです。",
          },
          sk,
        ),
      );

      const results = await relay.query([{ kinds: [1] }]);
      assert.equal(results.length, 2);
    });
  });

  describe("NIP-50 sentiment filter", () => {
    // Mock client with sentiment field support
    const createSentimentMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryMust = (
              (body.query as Record<string, unknown>)?.bool as Record<
                string,
                unknown
              >
            )?.must as Array<Record<string, unknown>> | undefined;

            // Extract sentiment filter if present
            let sentimentFilter: string | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.sentiment) {
                sentimentFilter = (clause.term as Record<string, unknown>)
                  .sentiment as string;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                sentiment?: string;
              };

              if (docTyped.deleted) continue;
              if (sentimentFilter && docTyped.sentiment !== sentimentFilter)
                continue;

              results.push({ _source: doc });
            }

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should store sentiment on indexed documents when passed via analysis", async () => {
      const { client, documents } = createSentimentMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content:
            "I love this amazing wonderful fantastic excellent brilliant masterpiece!",
        },
        sk,
      );

      await relay.event(event, { analysis: { sentiment: "positive" } });

      const doc = Array.from(documents.values())[0] as {
        sentiment?: string;
      };
      assert.equal(doc.sentiment, "positive");
    });

    it("should filter events by sentiment using search extension", async () => {
      const { client } = createSentimentMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Positive event
      const positiveEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content:
            "I love this amazing wonderful fantastic excellent brilliant masterpiece!",
        },
        sk,
      );

      // Negative event
      const negativeEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [],
          content:
            "This is terrible awful horrible disgusting dreadful painful ugly catastrophe",
        },
        sk,
      );

      await relay.event(positiveEvent, { analysis: { sentiment: "positive" } });
      await relay.event(negativeEvent, { analysis: { sentiment: "negative" } });

      // Filter by positive
      const positiveResults = await relay.query([
        { kinds: [1], search: "sentiment:positive" },
      ]);
      assert.equal(positiveResults.length, 1);
      assert.equal(positiveResults[0].id, positiveEvent.id);

      // Filter by negative
      const negativeResults = await relay.query([
        { kinds: [1], search: "sentiment:negative" },
      ]);
      assert.equal(negativeResults.length, 1);
      assert.equal(negativeResults[0].id, negativeEvent.id);
    });

    it("should store sentiment for kind 7 reactions", async () => {
      const { client, documents } = createSentimentMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const likeEvent = finalizeEvent(
        {
          kind: 7,
          created_at: now,
          tags: [["e", "a".repeat(64)]],
          content: "+",
        },
        sk,
      );

      await relay.event(likeEvent, { analysis: { sentiment: "positive" } });

      const doc = Array.from(documents.values())[0] as {
        sentiment?: string;
      };
      assert.equal(doc.sentiment, "positive");
    });
  });

  describe("NIP-50 media/video filter", () => {
    // Mock client with media/video field support
    const createMediaMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryBool = (body.query as Record<string, unknown>)
              ?.bool as Record<string, unknown>;
            const queryMust = queryBool?.must as
              | Array<Record<string, unknown>>
              | undefined;
            const queryMustNot = queryBool?.must_not as
              | Array<Record<string, unknown>>
              | undefined;

            // Extract media filter if present
            let mediaFilter: boolean | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.media === true) {
                mediaFilter = true;
              }
            }
            for (const clause of queryMustNot || []) {
              if ((clause.term as Record<string, unknown>)?.media === true) {
                mediaFilter = false;
              }
            }

            // Extract video filter if present
            let videoFilter: boolean | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.video === true) {
                videoFilter = true;
              }
            }
            for (const clause of queryMustNot || []) {
              if ((clause.term as Record<string, unknown>)?.video === true) {
                videoFilter = false;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                media?: boolean;
                video?: boolean;
              };

              if (docTyped.deleted) continue;

              // Filter by media
              if (mediaFilter === true && !docTyped.media) continue;
              if (mediaFilter === false && docTyped.media === true) continue;

              // Filter by video
              if (videoFilter === true && !docTyped.video) continue;
              if (videoFilter === false && docTyped.video === true) continue;

              results.push({ _source: doc });
            }

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: {
              responses: requests.map(() => ({ hits: { hits: [] } })),
            },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should set media:true for events with imeta tags", async () => {
      const { client, documents } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "imeta",
              "url https://example.com/photo.jpg",
              "m image/jpeg",
              "dim 1920x1080",
            ],
          ],
          content: "Check out this photo https://example.com/photo.jpg",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, false);
    });

    it("should set video:true when all imeta attachments are video", async () => {
      const { client, documents } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["imeta", "url https://example.com/clip.mp4", "m video/mp4"]],
          content: "Watch this https://example.com/clip.mp4",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, true);
    });

    it("should not set video:true when imeta has mixed media types", async () => {
      const { client, documents } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            ["imeta", "url https://example.com/clip.mp4", "m video/mp4"],
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Mixed media post",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, false);
    });

    it("should not set media for events without media", async () => {
      const { client, documents } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Just a text post, no media here",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, false);
      assert.equal(doc.video, false);
    });

    it("should detect media from URLs in content as fallback for kind 1", async () => {
      const { client, documents } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Check this out https://example.com/photo.png",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
    });

    it("should detect video from URLs in content as fallback for kind 1", async () => {
      const { client, documents } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Watch this https://example.com/clip.mp4",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, true);
    });

    it("should filter events by media:true", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with media
      const mediaEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Photo post https://example.com/photo.jpg",
        },
        sk,
      );

      // Event without media
      const textEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(mediaEvent);
      await relay.event(textEvent);

      // media:true should return only the media event
      const mediaResults = await relay.query([
        { kinds: [1], search: "media:true" },
      ]);
      assert.equal(mediaResults.length, 1);
      assert.equal(mediaResults[0].id, mediaEvent.id);
    });

    it("should filter events by media:false", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with media
      const mediaEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Photo post https://example.com/photo.jpg",
        },
        sk,
      );

      // Event without media
      const textEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(mediaEvent);
      await relay.event(textEvent);

      // media:false should return only the text event
      const textResults = await relay.query([
        { kinds: [1], search: "media:false" },
      ]);
      assert.equal(textResults.length, 1);
      assert.equal(textResults[0].id, textEvent.id);
    });

    it("should filter events by video:true", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Video event
      const videoEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["imeta", "url https://example.com/clip.mp4", "m video/mp4"]],
          content: "Video post https://example.com/clip.mp4",
        },
        sk,
      );

      // Image event
      const imageEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Image post https://example.com/photo.jpg",
        },
        sk,
      );

      // Text event
      const textEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 2,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(videoEvent);
      await relay.event(imageEvent);
      await relay.event(textEvent);

      // video:true should return only the video event
      const videoResults = await relay.query([
        { kinds: [1], search: "video:true" },
      ]);
      assert.equal(videoResults.length, 1);
      assert.equal(videoResults[0].id, videoEvent.id);
    });

    it("should filter events by video:false", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Video event
      const videoEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["imeta", "url https://example.com/clip.mp4", "m video/mp4"]],
          content: "Video post https://example.com/clip.mp4",
        },
        sk,
      );

      // Image event
      const imageEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Image post https://example.com/photo.jpg",
        },
        sk,
      );

      await relay.event(videoEvent);
      await relay.event(imageEvent);

      // video:false should return the image event (has media but not video)
      const nonVideoResults = await relay.query([
        { kinds: [1], search: "video:false" },
      ]);
      assert.equal(nonVideoResults.length, 1);
      assert.equal(nonVideoResults[0].id, imageEvent.id);
    });

    it("should combine media and other search extensions", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // English media event
      const enMediaEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Photo post https://example.com/photo.jpg",
        },
        sk,
      );

      // English text event
      const enTextEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(enMediaEvent);
      await relay.event(enTextEvent);

      // media:true should return only the media event
      const mediaResults = await relay.query([
        { kinds: [1], search: "media:true" },
      ]);
      assert.equal(mediaResults.length, 1);
      assert.equal(mediaResults[0].id, enMediaEvent.id);
    });
  });

  describe("NIP-50 pow filter (NIP-13)", () => {
    // Mock client that interprets a `range` clause on the `pow` field by
    // comparing the stored document's pow value against the `gte` bound.
    const createPowMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryBool = (body.query as Record<string, unknown>)
              ?.bool as Record<string, unknown>;
            const queryMust = queryBool?.must as
              | Array<Record<string, unknown>>
              | undefined;

            // Extract a `pow >= N` lower bound if present.
            let powGte: number | undefined;
            for (const clause of queryMust || []) {
              const range = clause.range as
                | Record<string, Record<string, number>>
                | undefined;
              if (range?.pow?.gte !== undefined) {
                powGte = range.pow.gte;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                pow?: number;
              };

              if (docTyped.deleted) continue;
              if (powGte !== undefined && (docTyped.pow ?? 0) < powGte)
                continue;

              results.push({ _source: doc });
            }

            return { body: { hits: { hits: results } } };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as { index?: { _id: string } };
              const payload = body[i + 1] as Record<string, unknown>;
              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              }
            }
            return { body: { errors: false, items } };
          },
          count: async () => ({ body: { count: documents.size } }),
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: { responses: requests.map(() => ({ hits: { hits: [] } })) },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    /**
     * Mine a kind 1 event to at least `target` leading zero bits by
     * incrementing the nonce. Used to produce cheap, real proof-of-work in
     * tests (targets are kept small so mining stays fast).
     */
    const mineEvent = (
      sk: Uint8Array,
      created_at: number,
      target: number,
    ): NostrEvent => {
      let nonce = 0;
      for (;;) {
        const event = finalizeEvent(
          {
            kind: 1,
            created_at,
            tags: [["nonce", String(nonce), String(target)]],
            content: "mined",
          },
          sk,
        );
        // Count leading zero bits of the id.
        let bits = 0;
        for (let i = 0; i < event.id.length; i++) {
          const n = Number.parseInt(event.id[i], 16);
          if (n === 0) {
            bits += 4;
          } else {
            bits += Math.clz32(n) - 28;
            break;
          }
        }
        if (bits >= target) return event;
        nonce++;
      }
    };

    it("stores pow=0 for events without a nonce tag", async () => {
      const { client, documents } = createPowMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        { kind: 1, created_at: 1000, tags: [], content: "no pow" },
        sk,
      );
      await relay.event(event);

      const doc = documents.get(event.id) as { pow: number };
      assert.equal(doc.pow, 0);
    });

    it("stores the computed difficulty for a mined event", async () => {
      const { client, documents } = createPowMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const mined = mineEvent(sk, 1000, 8);
      await relay.event(mined);

      const doc = documents.get(mined.id) as { pow: number };
      assert.ok(doc.pow >= 8);
    });

    it("filters events by pow:<n> (difficulty >= n)", async () => {
      const { client } = createPowMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();

      // Event with no proof of work (pow=0).
      const plain = finalizeEvent(
        { kind: 1, created_at: 1000, tags: [], content: "plain" },
        sk,
      );
      // Event mined to at least 8 bits of difficulty.
      const mined = mineEvent(sk, 1001, 8);

      await relay.event(plain);
      await relay.event(mined);

      // pow:8 should return only the mined event.
      const highPow = await relay.query([{ kinds: [1], search: "pow:8" }]);
      assert.equal(highPow.length, 1);
      assert.equal(highPow[0].id, mined.id);

      // pow:0 should return both events.
      const allPow = await relay.query([{ kinds: [1], search: "pow:0" }]);
      assert.equal(allPow.length, 2);
    });

    it("ignores a non-numeric pow value", async () => {
      const { client } = createPowMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const plain = finalizeEvent(
        { kind: 1, created_at: 1000, tags: [], content: "plain" },
        sk,
      );
      await relay.event(plain);

      // A malformed pow token adds no clause, so the event still matches.
      const results = await relay.query([{ kinds: [1], search: "pow:abc" }]);
      assert.equal(results.length, 1);
    });
  });

  describe("NIP-50 tag existence filter (tag:/-tag:)", () => {
    // Mock client that interprets `exists` clauses on tags_map.* fields by
    // inspecting the stored document's tags_map. Mirrors how OpenSearch's
    // `_field_names`-backed exists query behaves: a field "exists" when the
    // tags_map has a non-empty array for that tag name.
    const createTagExistsMockClient = () => {
      const documents = new Map<string, unknown>();

      const collectExistsFields = (
        clauses: Array<Record<string, unknown>> | undefined,
      ): string[] => {
        const fields: string[] = [];
        for (const clause of clauses || []) {
          const field = (clause.exists as Record<string, unknown>)?.field as
            | string
            | undefined;
          if (field?.startsWith("tags_map.")) {
            fields.push(field.slice("tags_map.".length));
          }
        }
        return fields;
      };

      const hasTag = (
        doc: { tags_map?: Record<string, string[]> },
        name: string,
      ): boolean => {
        const values = doc.tags_map?.[name];
        return Array.isArray(values) && values.length > 0;
      };

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryBool = (body.query as Record<string, unknown>)
              ?.bool as Record<string, unknown>;
            const queryMust = queryBool?.must as
              | Array<Record<string, unknown>>
              | undefined;
            const queryMustNot = queryBool?.must_not as
              | Array<Record<string, unknown>>
              | undefined;

            const requiredTags = collectExistsFields(queryMust);
            const excludedTags = collectExistsFields(queryMustNot);

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                tags_map?: Record<string, string[]>;
              };

              if (docTyped.deleted) continue;

              // tag:<name> — must have the tag
              if (requiredTags.some((name) => !hasTag(docTyped, name))) {
                continue;
              }
              // -tag:<name> — must not have the tag
              if (excludedTags.some((name) => hasTag(docTyped, name))) {
                continue;
              }

              results.push({ _source: doc });
            }

            return { body: { hits: { hits: results } } };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return { body: { errors: false, items } };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => ({ body: { count: documents.size } }),
          updateByQuery: async () => ({ body: { updated: 0 } }),
          msearch: async (requests: unknown[]) => ({
            body: { responses: requests.map(() => ({ hits: { hits: [] } })) },
          }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    const setupRelay = () => {
      const { client } = createTagExistsMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });
      return relay;
    };

    it("tag:e returns only events that have an e tag", async () => {
      const relay = setupRelay();
      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const withE = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["e", "f".repeat(64)]],
          content: "has e tag",
        },
        sk,
      );
      const withoutE = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1,
          tags: [["p", "a".repeat(64)]],
          content: "no e tag",
        },
        sk,
      );

      await relay.event(withE);
      await relay.event(withoutE);

      const results = await relay.query([{ kinds: [1], search: "tag:e" }]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, withE.id);
    });

    it("-tag:e returns only events that lack an e tag", async () => {
      const relay = setupRelay();
      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const withE = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["e", "f".repeat(64)]],
          content: "has e tag",
        },
        sk,
      );
      const withoutE = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1,
          tags: [["p", "a".repeat(64)]],
          content: "no e tag",
        },
        sk,
      );

      await relay.event(withE);
      await relay.event(withoutE);

      const results = await relay.query([{ kinds: [1], search: "-tag:e" }]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, withoutE.id);
    });

    it("combines tag: and -tag: in a single search", async () => {
      const relay = setupRelay();
      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // has e, no p
      const eOnly = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["e", "f".repeat(64)]],
          content: "e only",
        },
        sk,
      );
      // has e and p
      const eAndP = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1,
          tags: [
            ["e", "f".repeat(64)],
            ["p", "a".repeat(64)],
          ],
          content: "e and p",
        },
        sk,
      );

      await relay.event(eOnly);
      await relay.event(eAndP);

      // Want events with an e tag but without a p tag.
      const results = await relay.query([
        { kinds: [1], search: "tag:e -tag:p" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, eOnly.id);
    });

    it("ignores tag: on non-indexable tag names", async () => {
      const relay = setupRelay();
      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // "title" is not in the multi-letter whitelist, so it is never indexed
      // in tags_map. tag:title must therefore be a no-op (not filter to zero).
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["title", "Hello"]],
          content: "titled",
        },
        sk,
      );

      await relay.event(event);

      const results = await relay.query([{ kinds: [1], search: "tag:title" }]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, event.id);
    });
  });

  describe("detectMedia", () => {
    it("should detect media from imeta tags", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [["imeta", "url https://example.com/photo.jpg", "m image/jpeg"]],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true });
    });

    it("should detect video when all imeta are video", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [
          ["imeta", "url https://example.com/a.mp4", "m video/mp4"],
          ["imeta", "url https://example.com/b.webm", "m video/webm"],
        ],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true, video: true });
    });

    it("should not detect video when imeta has mixed types", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [
          ["imeta", "url https://example.com/a.mp4", "m video/mp4"],
          ["imeta", "url https://example.com/b.jpg", "m image/jpeg"],
        ],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true });
    });

    it("should return empty for events without media", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [],
        content: "just text",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, {});
    });

    it("should fall back to URL detection for kind 1 without imeta", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [],
        content: "look at https://example.com/photo.png",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true });
    });

    it("should not fall back to URL detection for non-kind-1 events", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 30023,
        tags: [],
        content: "article with https://example.com/photo.png",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, {});
    });

    it("should skip imeta tags without url field", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [["imeta", "m image/jpeg", "dim 1920x1080"]],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      // No valid imeta (missing url), falls back to URL detection
      // Content has no media URLs either
      assert.deepEqual(result, {});
    });

    it("should not set video when imeta lacks mime type", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [["imeta", "url https://example.com/clip.mp4"]],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      // Has media (valid imeta with url), but can't confirm video without m tag
      assert.deepEqual(result, { media: true });
    });
  });

  describe("migrate", () => {
    it("should reject documents with unknown fields (dynamic: strict)", async () => {
      const KNOWN_FIELDS = new Set([
        "id",
        "pubkey",
        "created_at",
        "kind",
        "tags",
        "tags_map",
        "search_text",
        "content",
        "sig",
        "deleted",
        "replaced",
        "protocol",
        "amount_msats",
        "language",
        "sentiment",
        "media",
        "video",
        "pow",
        "followers",
        "engagers",
        "comment_cnt",
        "reaction_cnt",
        "repost_cnt",
        "quote_cnt",
        "zap_amount_msats",
        "zap_cnt",
      ]);

      const mockClient = {
        bulk: async ({ body }: { body: unknown[] }) => {
          const items: Array<Record<string, unknown>> = [];
          for (let i = 0; i < body.length; i += 2) {
            const action = body[i] as { index?: { _id: string } };
            const payload = body[i + 1] as Record<string, unknown>;

            if (action.index) {
              // Simulate dynamic: strict — reject docs with unknown fields
              const unknownFields = Object.keys(payload).filter(
                (key) => !KNOWN_FIELDS.has(key),
              );
              if (unknownFields.length > 0) {
                items.push({
                  index: {
                    error: {
                      type: "strict_dynamic_mapping_exception",
                      reason: `mapping set to strict, dynamic introduction of [${unknownFields[0]}] within [_doc] is not allowed`,
                    },
                  },
                });
              } else {
                items.push({ index: {} });
              }
            }
          }
          return {
            body: {
              errors: items.some(
                (item) =>
                  (item.index as { error?: unknown } | undefined)?.error,
              ),
              items,
            },
          };
        },
        mget: async ({ body }: { body: { ids: string[] } }) => ({
          body: {
            docs: body.ids.map((id) => ({ found: false, _id: id })),
          },
        }),
        updateByQuery: async () => ({ body: { updated: 0 } }),
        msearch: async (requests: unknown[]) => ({
          body: {
            responses: requests.map(() => ({ hits: { hits: [] } })),
          },
        }),
        indices: {
          exists: async () => ({ body: true }),
          create: async () => ({ body: {} }),
        },
        close: async () => {},
      };

      const relay = new OpenSearchRelay(mockClient as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
        refreshDelayMs: 0,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Normal event",
        },
        sk,
      );

      // A well-formed event should be accepted
      await relay.event(event);

      // An event with a spoofed extra field should be rejected
      const badEvent = {
        ...finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: "Bad event",
          },
          sk,
        ),
        mystery_field: "should not be allowed",
      };

      await assert.rejects(() => relay.event(badEvent), {
        message: /strict_dynamic_mapping_exception/,
      });
    });
  });

  describe("parseBolt11Amount", () => {
    it("should parse nano-BTC amounts", () => {
      // 210n = 210 nano-BTC = 21 sats = 21,000 msats
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("lnbc210n1p5eyu7fpp5..."),
        21_000,
      );
    });

    it("should parse micro-BTC amounts", () => {
      // 10u = 10 micro-BTC = 1000 sats = 1,000,000 msats
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("lnbc10u1p5..."),
        1_000_000,
      );
    });

    it("should parse milli-BTC amounts", () => {
      // 1m = 1 milli-BTC = 100,000 sats = 100,000,000 msats
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("lnbc1m1p5..."),
        100_000_000,
      );
    });

    it("should parse pico-BTC amounts", () => {
      // 100p = 100 pico-BTC = 10 msats
      assert.equal(OpenSearchRelay.parseBolt11Amount("lnbc100p1p5..."), 10);
    });

    it("should return undefined for invalid bolt11", () => {
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("not-a-bolt11"),
        undefined,
      );
      assert.equal(OpenSearchRelay.parseBolt11Amount(""), undefined);
    });

    it("should parse real-world bolt11 invoices", () => {
      // 21 sats = 21,000 msats
      const bolt11 =
        "lnbc210n1p5e2srfpp5x4fd3rjklja8fhvn3y5vjnrc00775805hts9rewjl2v3g8ma7d5q";
      assert.equal(OpenSearchRelay.parseBolt11Amount(bolt11), 21_000);
    });
  });

  describe("parseOnchainZapAmount", () => {
    /** Build a minimal kind 8333 event with the given tags. */
    const makeEvt = (tags: string[][]) => ({
      id: "e".repeat(64),
      pubkey: "a".repeat(64),
      created_at: 0,
      kind: 8333,
      tags,
      content: "",
      sig: "",
    });

    it("returns msats (sats × 1000) from the `amount` tag", () => {
      const evt = makeEvt([
        ["i", `bitcoin:tx:${"f".repeat(64)}`],
        ["p", "b".repeat(64)],
        ["amount", "25000"],
      ]);
      assert.equal(OpenSearchRelay.parseOnchainZapAmount(evt), 25_000_000);
    });

    it("returns 0 for an amount of zero", () => {
      const evt = makeEvt([["amount", "0"]]);
      assert.equal(OpenSearchRelay.parseOnchainZapAmount(evt), 0);
    });

    it("returns undefined when no amount tag is present", () => {
      const evt = makeEvt([["p", "b".repeat(64)]]);
      assert.equal(OpenSearchRelay.parseOnchainZapAmount(evt), undefined);
    });

    it("returns undefined for non-integer amounts", () => {
      assert.equal(
        OpenSearchRelay.parseOnchainZapAmount(makeEvt([["amount", "1.5"]])),
        undefined,
      );
      assert.equal(
        OpenSearchRelay.parseOnchainZapAmount(makeEvt([["amount", "-1"]])),
        undefined,
      );
      assert.equal(
        OpenSearchRelay.parseOnchainZapAmount(makeEvt([["amount", "abc"]])),
        undefined,
      );
      assert.equal(
        OpenSearchRelay.parseOnchainZapAmount(makeEvt([["amount", ""]])),
        undefined,
      );
    });
  });

  describe("authKinds exclusion with ids filter", () => {
    it("should exclude auth kinds from queries without ids or explicit kinds", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockClient = {
        search: async ({ body }: { body: Record<string, unknown> }) => {
          capturedBody = body;
          return {
            body: { hits: { hits: [], total: { value: 0 } } },
          };
        },
      } as unknown as Client;

      const relay = new OpenSearchRelay(mockClient, {
        authKinds: new Set([4, 1059]),
      });

      await relay.query([{ authors: ["a".repeat(64)] }]);

      assert.ok(capturedBody);
      const boolQuery = (capturedBody.query as Record<string, unknown>)
        .bool as Record<string, unknown>;
      const mustNot = boolQuery.must_not as Array<Record<string, unknown>>;

      // Should have a must_not clause excluding auth kinds
      const kindExclusion = mustNot.find(
        (c) => (c.terms as Record<string, unknown>)?.kind,
      );
      assert.ok(kindExclusion, "should exclude auth kinds");
      const excludedKinds = (kindExclusion?.terms as Record<string, number[]>)
        .kind;
      assert.ok(excludedKinds.includes(4));
      assert.ok(excludedKinds.includes(1059));
    });

    it("should NOT exclude auth kinds when ids are present", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockClient = {
        search: async ({ body }: { body: Record<string, unknown> }) => {
          capturedBody = body;
          return {
            body: { hits: { hits: [], total: { value: 0 } } },
          };
        },
      } as unknown as Client;

      const relay = new OpenSearchRelay(mockClient, {
        authKinds: new Set([4, 1059]),
      });

      await relay.query([{ ids: [`${"abc".repeat(20)}abcd`] }]);

      assert.ok(capturedBody);
      const boolQuery = (capturedBody.query as Record<string, unknown>)
        .bool as Record<string, unknown>;
      const mustNot =
        (boolQuery.must_not as Array<Record<string, unknown>>) || [];

      // Should NOT have a must_not clause excluding auth kinds
      const kindExclusion = mustNot.find(
        (c) => (c.terms as Record<string, unknown>)?.kind,
      );
      assert.equal(
        kindExclusion,
        undefined,
        "should not exclude auth kinds when ids present",
      );
    });
  });

  describe("bulkMaxQueue backpressure", () => {
    it("should reject event() with StorageOverloaded when queue is full", async () => {
      // Mock client whose bulk() never resolves — the queue fills up and
      // the next event() call must throw synchronously instead of growing
      // the queue without bound.
      const mockClient = {
        bulk: () =>
          new Promise(() => {
            /* never resolves */
          }),
      } as unknown as Client;

      const relay = new OpenSearchRelay(mockClient, {
        // Set the queue cap to 2, and bulkMaxSize > 2 so the queue doesn't
        // auto-flush before the cap is reached.
        bulkMaxSize: 10,
        bulkMaxQueue: 2,
      });

      const sk = generateSecretKey();
      const ev = (i: number): NostrEvent =>
        finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: `event ${i}`,
          },
          sk,
        );

      // First two go in fine (don't await; they'll never resolve because
      // bulk() never resolves).
      const p1 = relay.event(ev(1)).catch(() => {});
      const p2 = relay.event(ev(2)).catch(() => {});

      // Third must reject with StorageOverloaded.
      await assert.rejects(relay.event(ev(3)), {
        name: "StorageOverloaded",
      });

      // Suppress unresolved-promise warnings on p1/p2 — they're intentional.
      void p1;
      void p2;
    });
  });

  describe("queryItems (NIP-77 sync)", () => {
    /** Dataset of (created_at, id) docs sorted ascending by (created_at, id). */
    const makeDataset = (count: number): Array<[number, string]> => {
      const docs: Array<[number, string]> = [];
      for (let i = 0; i < count; i++) {
        // Repeat timestamps to exercise the id tiebreaker.
        const createdAt = 1000 + Math.floor(i / 3);
        const id = `${String(i).padStart(4, "0")}${"0".repeat(60)}`;
        docs.push([createdAt, id]);
      }
      docs.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : 1));
      return docs;
    };
    /**
     * Mock client whose `search` honors (created_at, id) sort in either
     * direction, `search_after`, and `size` — enough to exercise pagination.
     */
    const createItemsMockClient = (docs: Array<[number, string]>) => {
      const requests: Array<Record<string, unknown>> = [];
      const client = {
        search: async ({ body }: { body: Record<string, unknown> }) => {
          requests.push(body);

          const sort = body.sort as Array<Record<string, { order: string }>>;
          const order = sort[0].created_at.order;
          assert.deepEqual(sort, [
            { created_at: { order } },
            { id: { order } },
          ]);

          const size = body.size as number;
          const after = body.search_after as [number, string] | undefined;

          let ordered = docs;
          if (order === "desc") {
            ordered = [...docs].reverse();
          }

          let filtered = ordered;
          if (after) {
            filtered = ordered.filter(([ts, id]) =>
              order === "asc"
                ? ts > after[0] || (ts === after[0] && id > after[1])
                : ts < after[0] || (ts === after[0] && id < after[1]),
            );
          }

          const page = filtered.slice(0, size);
          return {
            body: {
              hits: {
                hits: page.map(([created_at, id]) => ({
                  _source: { created_at, id },
                  sort: [created_at, id],
                })),
              },
            },
          };
        },
      };
      return { client, requests };
    };

    it("returns all items in ascending (created_at, id) order across pages", async () => {
      const docs = makeDataset(25);
      const { client, requests } = createItemsMockClient(docs);
      const relay = new OpenSearchRelay(client as unknown as Client);

      const items = await relay.queryItems({ kinds: [1] }, { pageSize: 10 });

      assert.equal(items.length, 25);
      assert.deepEqual(
        items.map((i) => [i.created_at, i.id]),
        docs,
      );
      // 25 docs at 10 per page = 3 requests (last page is short).
      assert.equal(requests.length, 3);
      // Subsequent requests paginate with search_after from the previous tail.
      assert.deepEqual(requests[1].search_after, docs[9]);
      assert.deepEqual(requests[2].search_after, docs[19]);
    });

    it("stops at maxItems", async () => {
      const docs = makeDataset(30);
      const { client } = createItemsMockClient(docs);
      const relay = new OpenSearchRelay(client as unknown as Client);

      const items = await relay.queryItems(
        { kinds: [1] },
        { maxItems: 12, pageSize: 10 },
      );

      assert.equal(items.length, 12);
      assert.deepEqual(
        items.map((i) => [i.created_at, i.id]),
        docs.slice(0, 12),
      );
    });

    it("returns an empty array when nothing matches", async () => {
      const { client, requests } = createItemsMockClient([]);
      const relay = new OpenSearchRelay(client as unknown as Client);

      const items = await relay.queryItems({ kinds: [1] });

      assert.deepEqual(items, []);
      assert.equal(requests.length, 1);
    });

    it("honors limit by returning the N newest items in ascending order", async () => {
      const docs = makeDataset(30);
      const { client, requests } = createItemsMockClient(docs);
      const relay = new OpenSearchRelay(client as unknown as Client);

      const items = await relay.queryItems(
        { kinds: [1], limit: 12 },
        { pageSize: 10 },
      );

      // The 12 newest docs, flipped back to ascending order.
      assert.equal(items.length, 12);
      assert.deepEqual(
        items.map((i) => [i.created_at, i.id]),
        docs.slice(-12),
      );
      // Limited queries iterate descending.
      const sort = requests[0].sort as Array<Record<string, { order: string }>>;
      assert.equal(sort[0].created_at.order, "desc");
      // 12 items at 10 per page = 2 requests.
      assert.equal(requests.length, 2);
    });

    it("returns no items when limit is 0", async () => {
      const docs = makeDataset(5);
      const { client, requests } = createItemsMockClient(docs);
      const relay = new OpenSearchRelay(client as unknown as Client);

      const items = await relay.queryItems({ kinds: [1], limit: 0 });

      assert.deepEqual(items, []);
      assert.equal(requests.length, 0);
    });

    it("excludes deleted/replaced docs and fetches only sync fields", async () => {
      const { client, requests } = createItemsMockClient([]);
      const relay = new OpenSearchRelay(client as unknown as Client);

      await relay.queryItems({ kinds: [1] });

      const body = requests[0];
      assert.equal(body.size, 10_000);
      // Only the sync fields are fetched.
      assert.deepEqual(body._source, ["created_at", "id"]);

      const query = body.query as {
        bool: {
          must: Array<Record<string, unknown>>;
          must_not?: Array<Record<string, unknown>>;
        };
      };
      assert.ok(
        query.bool.must.some(
          (clause) =>
            (clause.term as { deleted?: boolean } | undefined)?.deleted ===
            false,
        ),
      );
      assert.ok(
        query.bool.must_not?.some(
          (clause) =>
            (clause.term as { replaced?: boolean } | undefined)?.replaced ===
            true,
        ),
      );
    });
  });
});

describe("OpenSearchRelay.recomputeScores", () => {
  /**
   * Mock client covering just the three request shapes recomputeScores
   * issues: the Phase 1 dirty-id lookup (search), the Phase 2 engagement
   * fan-out (msearch), and the Phase 4 write-back (bulk).
   *
   * `referencing` describes the events pointing at the target, so the mock
   * can answer each engagement sub-query by evaluating its kind set and
   * tags_map field rather than by relying on msearch ordering — otherwise
   * the test would just re-assert the ordering the code already assumes.
   */
  const createScoreMockClient = (opts: {
    dirty: Array<{ id: string; kind: number; pubkey: string }>;
    referencing: Array<{ kind: number; pubkey: string; via: "e" | "q" }>;
  }) => {
    const written: Array<{ id: string; doc: Record<string, unknown> }> = [];

    const client = {
      search: async () => ({
        body: { hits: { hits: opts.dirty.map((d) => ({ _source: d })) } },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      msearch: async (requests: Array<{ body: any }>) => ({
        body: {
          responses: requests.map((req) => {
            const must = req.body.query.bool.must as Array<
              Record<string, unknown>
            >;
            const kinds = (
              must.find((c) => "terms" in c) as
                | { terms: { kind: number[] } }
                | undefined
            )?.terms?.kind;
            const tagClause = must.find(
              (c) =>
                "term" in c &&
                Object.keys(
                  (c as { term: Record<string, unknown> }).term,
                )[0].startsWith("tags_map."),
            ) as { term: Record<string, unknown> } | undefined;
            const via = Object.keys(tagClause?.term ?? {})[0]?.slice(
              "tags_map.".length,
            );

            const matched = opts.referencing.filter(
              (r) => kinds?.includes(r.kind) && r.via === via,
            );

            // Trusted (WoT) mode: answer with a per-pubkey terms agg,
            // optionally carrying the zap-amount sum per bucket.
            if (req.body.aggs?.by_pubkey) {
              const byPubkey = new Map<string, number>();
              for (const r of matched) {
                byPubkey.set(r.pubkey, (byPubkey.get(r.pubkey) ?? 0) + 1);
              }
              const wantsMsats = Boolean(req.body.aggs.by_pubkey.aggs);
              const buckets = [...byPubkey.entries()].map(([key, count]) => ({
                key,
                doc_count: count,
                // Every zap in this fixture carries 1000 msats.
                ...(wantsMsats && { total_msats: { value: count * 1000 } }),
              }));
              return {
                hits: { total: { value: matched.length } },
                aggregations: { by_pubkey: { buckets } },
              };
            }

            const aggs: Record<string, { value: number }> = {};
            if (req.body.aggs?.total_msats) {
              // Every zap in this fixture carries 1000 msats.
              aggs.total_msats = { value: matched.length * 1000 };
            }
            if (req.body.aggs?.unique_authors) {
              aggs.unique_authors = {
                value: new Set(matched.map((r) => r.pubkey)).size,
              };
            }

            return {
              hits: { total: { value: matched.length } },
              ...(Object.keys(aggs).length > 0 && { aggregations: aggs }),
            };
          }),
        },
      }),
      bulk: async ({ body }: { body: unknown[] }) => {
        for (let i = 0; i < body.length; i += 2) {
          const action = body[i] as { update?: { _id: string } };
          const payload = body[i + 1] as { doc: Record<string, unknown> };
          if (action.update) {
            written.push({ id: action.update._id, doc: payload.doc });
          }
        }
        return { body: { errors: false, items: [] } };
      },
    };

    return { client, written };
  };

  it("maps each engagement sub-query onto its score field", async () => {
    const targetId = "a".repeat(64);
    const { client, written } = createScoreMockClient({
      dirty: [{ id: targetId, kind: 1, pubkey: "b".repeat(64) }],
      referencing: [
        // 2 comments (kinds 1 and 1111 via `e`)
        { kind: 1, pubkey: "c".repeat(64), via: "e" },
        { kind: 1111, pubkey: "d".repeat(64), via: "e" },
        // 3 reactions (kind 7 via `e`)
        { kind: 7, pubkey: "c".repeat(64), via: "e" },
        { kind: 7, pubkey: "d".repeat(64), via: "e" },
        { kind: 7, pubkey: "e".repeat(64), via: "e" },
        // 1 repost (kind 6 via `e`)
        { kind: 6, pubkey: "f".repeat(64), via: "e" },
        // 2 zaps (kinds 9735 + 8333 via `e`) => 2000 msats
        { kind: 9735, pubkey: "c".repeat(64), via: "e" },
        { kind: 8333, pubkey: "f".repeat(64), via: "e" },
        // 1 quote (kind 1 via `q`)
        { kind: 1, pubkey: "e".repeat(64), via: "q" },
      ],
    });

    const relay = new OpenSearchRelay(client as unknown as Client, {
      indexName: "test-index",
    });
    relay.addDirtyIds([targetId]);

    const result = await relay.recomputeScores();

    assert.equal(result.count, 1);
    const scores = result.eventScores.get(targetId);
    assert.ok(scores);
    assert.equal(scores.comment_cnt, 2);
    assert.equal(scores.reaction_cnt, 3);
    assert.equal(scores.repost_cnt, 1);
    assert.equal(scores.quote_cnt, 1);
    assert.equal(scores.zap_cnt, 2);
    assert.equal(scores.zap_amount_msats, 2000);

    // Unique engagers spans all `e`-referencing engagement kinds:
    // pubkeys c, d, e, f.
    const write = written.find((w) => w.id === targetId);
    assert.ok(write);
    assert.equal(write.doc.engagers, 4);
  });

  it("writes back only the fields computed for the document's kind", async () => {
    const profileId = "a".repeat(64);
    const noteId = "b".repeat(64);
    const author = "c".repeat(64);

    const { client, written } = createScoreMockClient({
      dirty: [
        { id: profileId, kind: 0, pubkey: author },
        { id: noteId, kind: 1, pubkey: author },
      ],
      referencing: [{ kind: 7, pubkey: "d".repeat(64), via: "e" }],
    });

    const relay = new OpenSearchRelay(client as unknown as Client, {
      indexName: "test-index",
    });
    relay.addDirtyIds([profileId, noteId]);

    await relay.recomputeScores();

    // Phase 2b skips kind 0, so a profile must not have engagement counts
    // written at all — previously they were overwritten with zeros on every
    // recompute.
    const profileWrite = written.find((w) => w.id === profileId);
    assert.ok(profileWrite);
    assert.deepEqual(Object.keys(profileWrite.doc), ["followers"]);

    // Symmetrically, a non-kind-0 event has no follower count to write.
    const noteWrite = written.find((w) => w.id === noteId);
    assert.ok(noteWrite);
    assert.ok(!("followers" in noteWrite.doc));
    assert.equal(noteWrite.doc.reaction_cnt, 1);
  });

  it("returns early when nothing is dirty", async () => {
    const { client } = createScoreMockClient({ dirty: [], referencing: [] });
    const relay = new OpenSearchRelay(client as unknown as Client, {
      indexName: "test-index",
    });

    const result = await relay.recomputeScores();
    assert.equal(result.count, 0);
    assert.equal(result.eventScores.size, 0);
  });

  it("counts only trusted authors when a trust provider is active", async () => {
    const targetId = "a".repeat(64);
    const trustedPk = "c".repeat(64);
    const puppet1 = "d".repeat(64);
    const puppet2 = "e".repeat(64);

    const { client, written } = createScoreMockClient({
      dirty: [{ id: targetId, kind: 1, pubkey: "b".repeat(64) }],
      referencing: [
        // Trusted: one comment and one zap.
        { kind: 1, pubkey: trustedPk, via: "e" },
        { kind: 9735, pubkey: trustedPk, via: "e" },
        // Sybil swarm: reactions, a repost, a quote, and a zap.
        { kind: 7, pubkey: puppet1, via: "e" },
        { kind: 7, pubkey: puppet2, via: "e" },
        { kind: 6, pubkey: puppet1, via: "e" },
        { kind: 1, pubkey: puppet2, via: "q" },
        { kind: 9735, pubkey: puppet2, via: "e" },
      ],
    });

    const relay = new OpenSearchRelay(client as unknown as Client, {
      indexName: "test-index",
    });
    relay.trustProvider = () => new Set([trustedPk]);
    relay.addDirtyIds([targetId]);

    const result = await relay.recomputeScores();

    const scores = result.eventScores.get(targetId);
    assert.ok(scores);
    assert.equal(scores.comment_cnt, 1);
    assert.equal(scores.reaction_cnt, 0);
    assert.equal(scores.repost_cnt, 0);
    assert.equal(scores.quote_cnt, 0);
    assert.equal(scores.zap_cnt, 1);
    assert.equal(scores.zap_amount_msats, 1000);

    // Only the trusted pubkey counts as an engager, not the puppets.
    const write = written.find((w) => w.id === targetId);
    assert.ok(write);
    assert.equal(write.doc.engagers, 1);
  });

  it("falls back to unfiltered counting when the provider returns undefined", async () => {
    const targetId = "a".repeat(64);
    const { client, written } = createScoreMockClient({
      dirty: [{ id: targetId, kind: 1, pubkey: "b".repeat(64) }],
      referencing: [
        { kind: 7, pubkey: "c".repeat(64), via: "e" },
        { kind: 7, pubkey: "d".repeat(64), via: "e" },
      ],
    });

    const relay = new OpenSearchRelay(client as unknown as Client, {
      indexName: "test-index",
    });
    // WoT configured but first refresh hasn't completed yet.
    relay.trustProvider = () => undefined;
    relay.addDirtyIds([targetId]);

    const result = await relay.recomputeScores();

    assert.equal(result.eventScores.get(targetId)?.reaction_cnt, 2);
    assert.equal(written.find((w) => w.id === targetId)?.doc.engagers, 2);
  });
});

describe("OpenSearchRelay.seedDirtyEngaged", () => {
  it("queues recent engaged event IDs as dirty", async () => {
    let captured: Record<string, unknown> | undefined;
    const client = {
      search: async (req: { body: Record<string, unknown> }) => {
        captured = req.body;
        return {
          body: {
            hits: {
              hits: [
                { _source: { id: "1".repeat(64) } },
                { _source: { id: "2".repeat(64) } },
              ],
            },
          },
        };
      },
    };

    const relay = new OpenSearchRelay(client as unknown as Client, {
      indexName: "test-index",
    });

    const count = await relay.seedDirtyEngaged(500);

    assert.equal(count, 2);
    assert.deepEqual(relay.drainDirty().ids.sort(), [
      "1".repeat(64),
      "2".repeat(64),
    ]);

    // The query is bounded: engaged-only, recent-only, top-N by engagers.
    assert.ok(captured);
    assert.equal(captured.size, 500);
    const must = (captured.query as { bool: { must: unknown[] } }).bool.must;
    assert.ok(
      must.some((c) => JSON.stringify(c).includes('"engagers":{"gt":0}')),
    );
    assert.ok(must.some((c) => JSON.stringify(c).includes("created_at")));
  });
});
