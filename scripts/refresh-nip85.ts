/**
 * Refresh NIP-85 stats for events matching a Nostr filter.
 *
 * Accepts a JSON Nostr filter as a CLI argument, scrolls through all
 * matching events in OpenSearch, recomputes their engagement scores,
 * updates the OpenSearch documents (engagers, comment_cnt, etc.), and
 * publishes updated NIP-85 assertion events:
 *
 * - Kind 30382: User stats for kind 0 profiles (followers, post_cnt)
 * - Kind 30383: Event stats for all other events (reactions, comments, etc.)
 *
 * Designed to scale from small targeted refreshes (e.g. reactions to a
 * single event) to full-index rebuilds (e.g. `'{}'`).
 *
 * Usage:
 *   bun run scripts/refresh-nip85.ts '{"kinds":[1111],"#e":["abc123..."]}'
 *   bun run scripts/refresh-nip85.ts '{}'
 */

import process from "node:process";
import type { NostrFilter } from "@nostrify/nostrify";
import { Config } from "../src/config.ts";
import { Nip85 } from "../src/nip85.ts";
import type { EventScores } from "../src/opensearch.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";
import type { ClientOptions } from "../src/opensearch-client.ts";
import { Client as OpenSearchClient } from "../src/opensearch-client.ts";
import { withRetry } from "./retry.ts";

const SCROLL_SIZE = 1000;
const SCROLL_TTL = "5m";
const BATCH_SIZE = 500;

/** Check if a string is a valid 64-char lowercase hex event ID. */
function isValidEventId(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** Build an OpenSearch query from a Nostr filter (simplified version for scrolling). */
function buildScrollQuery(filter: NostrFilter): Record<string, unknown> {
  const must: Record<string, unknown>[] = [{ term: { deleted: false } }];

  if (filter.ids && filter.ids.length > 0) {
    must.push({ terms: { id: filter.ids } });
  }
  if (filter.authors && filter.authors.length > 0) {
    must.push({ terms: { pubkey: filter.authors } });
  }
  if (filter.kinds && filter.kinds.length > 0) {
    must.push({ terms: { kind: filter.kinds } });
  }
  if (filter.since || filter.until) {
    const range: Record<string, number> = {};
    if (filter.since) range.gte = filter.since;
    if (filter.until) range.lte = filter.until;
    must.push({ range: { created_at: range } });
  }

  // Tag filters
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
      const tagName = key.substring(1);
      must.push({ terms: { [`tags_map.${tagName}`]: values } });
    }
  }

  return { bool: { must } };
}

/** Full scores for an event, including engagers for the OpenSearch document. */
interface FullScores extends EventScores {
  engagers: number;
}

/**
 * Compute engagement scores for a batch of event IDs.
 * Returns both the EventScores (for NIP-85) and engagers (for the OS document).
 */
async function computeEventScores(
  client: OpenSearchClient,
  indexName: string,
  eventIds: string[],
  clearCache: () => Promise<void>,
): Promise<Map<string, FullScores>> {
  const scores = new Map<string, FullScores>();
  if (eventIds.length === 0) return scores;

  // Initialize all with zeros.
  for (const id of eventIds) {
    scores.set(id, {
      engagers: 0,
      comment_cnt: 0,
      reaction_cnt: 0,
      repost_cnt: 0,
      quote_cnt: 0,
      zap_amount_msats: 0,
      zap_cnt: 0,
    });
  }

  // Query 1: Engagement (kinds 1/6/7/16/1111 via e-tag).
  const engagementResponse = await withRetry(
    () =>
      client.search({
        index: indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { terms: { kind: [1, 6, 7, 16, 1111] } },
                { terms: { "tags_map.e": eventIds } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_event: {
              terms: {
                field: "tags_map.e",
                size: eventIds.length,
                include: eventIds,
              },
              aggs: {
                unique_authors: {
                  cardinality: { field: "pubkey" },
                },
                by_kind: { terms: { field: "kind", size: 10 } },
              },
            },
          },
        },
      }),
    { onRetry: clearCache },
  );

  const engagementBuckets =
    (
      engagementResponse.body.aggregations?.by_event as unknown as {
        buckets?: Array<{
          key: string;
          doc_count: number;
          unique_authors?: { value: number };
          by_kind?: {
            buckets?: Array<{ key: number; doc_count: number }>;
          };
        }>;
      }
    )?.buckets || [];

  for (const bucket of engagementBuckets) {
    const s = scores.get(bucket.key);
    if (!s) continue;

    s.engagers = bucket.unique_authors?.value ?? 0;

    for (const kb of bucket.by_kind?.buckets || []) {
      switch (kb.key) {
        case 1:
        case 1111:
          s.comment_cnt += kb.doc_count;
          break;
        case 7:
          s.reaction_cnt += kb.doc_count;
          break;
        case 6:
        case 16:
          s.repost_cnt += kb.doc_count;
          break;
      }
    }
  }

  // Query 2: Zaps (kind 9735 via e-tag).
  const zapResponse = await withRetry(
    () =>
      client.search({
        index: indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { term: { kind: 9735 } },
                { terms: { "tags_map.e": eventIds } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_event: {
              terms: {
                field: "tags_map.e",
                size: eventIds.length,
                include: eventIds,
              },
              aggs: {
                total_msats: { sum: { field: "amount_msats" } },
              },
            },
          },
        },
      }),
    { onRetry: clearCache },
  );

  const zapBuckets =
    (
      zapResponse.body.aggregations?.by_event as unknown as {
        buckets?: Array<{
          key: string;
          doc_count: number;
          total_msats?: { value: number };
        }>;
      }
    )?.buckets || [];

  for (const bucket of zapBuckets) {
    const s = scores.get(bucket.key);
    if (s) {
      s.zap_amount_msats = bucket.total_msats?.value ?? 0;
      s.zap_cnt = bucket.doc_count;
    }
  }

  // Query 3: Quote reposts (kind 1 via q-tag).
  const quoteResponse = await withRetry(
    () =>
      client.search({
        index: indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { term: { kind: 1 } },
                { terms: { "tags_map.q": eventIds } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_event: {
              terms: {
                field: "tags_map.q",
                size: eventIds.length,
                include: eventIds,
              },
            },
          },
        },
      }),
    { onRetry: clearCache },
  );

  const quoteBuckets =
    (
      quoteResponse.body.aggregations?.by_event as unknown as {
        buckets?: Array<{ key: string; doc_count: number }>;
      }
    )?.buckets || [];

  for (const bucket of quoteBuckets) {
    const s = scores.get(bucket.key);
    if (s) {
      s.quote_cnt = bucket.doc_count;
    }
  }

  return scores;
}

/** Compute follower counts for a batch of pubkeys. */
async function computeFollowerCounts(
  client: OpenSearchClient,
  indexName: string,
  pubkeys: string[],
  clearCache: () => Promise<void>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (pubkeys.length === 0) return result;

  const response = await withRetry(
    () =>
      client.search({
        index: indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { term: { kind: 3 } },
                { terms: { "tags_map.p": pubkeys } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_pubkey: {
              terms: {
                field: "tags_map.p",
                size: pubkeys.length,
                include: pubkeys,
              },
            },
          },
        },
      }),
    { onRetry: clearCache },
  );

  const buckets =
    (
      response.body.aggregations?.by_pubkey as unknown as {
        buckets?: Array<{ key: string; doc_count: number }>;
      }
    )?.buckets || [];

  for (const bucket of buckets) {
    result.set(bucket.key, bucket.doc_count);
  }

  return result;
}

/**
 * Bulk-update engagement score fields on event documents by hex event ID.
 */
async function updateDocumentScores(
  client: OpenSearchClient,
  indexName: string,
  eventScores: Map<string, FullScores>,
): Promise<void> {
  if (eventScores.size === 0) return;

  const body: Array<Record<string, unknown>> = [];

  for (const [id, s] of eventScores) {
    if (!isValidEventId(id)) continue;
    body.push({
      update: { _index: indexName, _id: id },
    });
    body.push({
      doc: {
        engagers: s.engagers,
        comment_cnt: s.comment_cnt,
        reaction_cnt: s.reaction_cnt,
        repost_cnt: s.repost_cnt,
        quote_cnt: s.quote_cnt,
        zap_amount_msats: s.zap_amount_msats,
        zap_cnt: s.zap_cnt,
      },
    });
  }

  if (body.length === 0) return;

  const updateResponse = await client.bulk({ body, refresh: false });

  if (updateResponse.body.errors) {
    const items: Array<Record<string, { error?: unknown }>> =
      updateResponse.body.items;
    for (let i = 0; i < items.length; i++) {
      const result = items[i].update;
      if (result?.error) {
        console.warn(`Score update failed:`, JSON.stringify(result.error));
      }
    }
  }
}

/** Write follower counts back to kind 0 OpenSearch documents. */
async function updateFollowerCounts(
  client: OpenSearchClient,
  indexName: string,
  pubkeys: string[],
  followerCounts: Map<string, number>,
): Promise<void> {
  if (pubkeys.length === 0) return;

  const countParams: Record<string, number> = {};
  for (const pk of pubkeys) {
    countParams[pk] = followerCounts.get(pk) ?? 0;
  }

  await client.updateByQuery({
    index: indexName,
    body: {
      query: {
        bool: {
          must: [{ term: { kind: 0 } }, { terms: { pubkey: pubkeys } }],
        },
      },
      script: {
        source: `
          def count = params.counts.get(ctx._source.pubkey);
          if (count != null) {
            ctx._source.followers = count;
          }
        `,
        lang: "painless",
        params: { counts: countParams },
      },
    },
    refresh: false,
    conflicts: "proceed",
  });
}

async function main() {
  const filterArg = process.argv[2];
  if (!filterArg) {
    console.error(
      "Usage: bun run scripts/refresh-nip85.ts '<nostr-filter-json>'",
    );
    console.error(
      'Example: bun run scripts/refresh-nip85.ts \'{"kinds":[1111],"#e":["abc..."]}\'',
    );
    process.exit(1);
  }

  let filter: NostrFilter;
  try {
    filter = JSON.parse(filterArg);
  } catch {
    console.error("Invalid JSON filter:", filterArg);
    process.exit(1);
  }

  console.log("Starting NIP-85 stats refresh");
  console.log(`Filter: ${JSON.stringify(filter)}\n`);

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });

  const indexName = config.opensearchIndex;
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${indexName}\n`);

  const clientOptions: ClientOptions = {
    node: config.opensearchNode,
  };

  if (config.opensearchUsername && config.opensearchPassword) {
    clientOptions.auth = {
      username: config.opensearchUsername,
      password: config.opensearchPassword,
    };
  }

  const client = new OpenSearchClient(clientOptions);

  const relay = new OpenSearchRelay(client, { indexName });
  await relay.migrate();

  const nip85 = new Nip85({
    client,
    indexName,
    relay,
    signer: config.nostrSigner,
  });

  const clearCache = async () => {
    await client.indices.clearCache({ index: indexName, fielddata: true });
  };

  // Scroll through all matching events.
  const query = buildScrollQuery(filter);

  const initialResponse = await client.search({
    index: indexName,
    scroll: SCROLL_TTL,
    body: {
      size: SCROLL_SIZE,
      _source: ["id", "kind", "pubkey"],
      query,
    },
  });

  let scrollId = initialResponse.body._scroll_id as string;
  const hitsResult = initialResponse.body.hits as unknown as {
    total: { value: number };
    hits: Array<{ _source: { id: string; kind: number; pubkey: string } }>;
  };

  const total = hitsResult.total.value;
  console.log(`Found ${total.toLocaleString()} matching events\n`);

  if (total === 0) {
    console.log("Nothing to do.");
    await relay.close();
    return;
  }

  let processed = 0;
  let publishedEvents = 0;
  let publishedUsers = 0;

  // Accumulate events in batches.
  let eventIdBatch: string[] = [];
  let kind0PubkeyBatch: string[] = [];

  async function flushBatch() {
    // Flush non-kind-0 events: update OS documents + publish kind 30383.
    if (eventIdBatch.length > 0) {
      const scores = await computeEventScores(
        client,
        indexName,
        eventIdBatch,
        clearCache,
      );

      // Update OpenSearch documents with computed scores.
      await updateDocumentScores(client, indexName, scores);

      // Publish NIP-85 kind 30383 events (EventScores subset without engagers).
      const nip85Scores = new Map<string, EventScores>();
      for (const [id, s] of scores) {
        nip85Scores.set(id, {
          comment_cnt: s.comment_cnt,
          reaction_cnt: s.reaction_cnt,
          repost_cnt: s.repost_cnt,
          quote_cnt: s.quote_cnt,
          zap_amount_msats: s.zap_amount_msats,
          zap_cnt: s.zap_cnt,
        });
      }
      await nip85.publishEventStats(nip85Scores);

      publishedEvents += eventIdBatch.length;
      eventIdBatch = [];
    }

    // Flush kind 0 profiles: update OS documents + publish kind 30382.
    if (kind0PubkeyBatch.length > 0) {
      const followerCounts = await computeFollowerCounts(
        client,
        indexName,
        kind0PubkeyBatch,
        clearCache,
      );

      // Update OpenSearch documents with follower counts.
      await updateFollowerCounts(
        client,
        indexName,
        kind0PubkeyBatch,
        followerCounts,
      );

      // Publish NIP-85 kind 30382 events.
      const userScores = new Map<string, { followers: number }>();
      for (const pubkey of kind0PubkeyBatch) {
        userScores.set(pubkey, {
          followers: followerCounts.get(pubkey) ?? 0,
        });
      }
      await nip85.publishUserStats(userScores);

      publishedUsers += kind0PubkeyBatch.length;
      kind0PubkeyBatch = [];
    }
  }

  function logProgress() {
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
    console.log(
      `  Progress: ${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — ${publishedEvents.toLocaleString()} event stats, ${publishedUsers.toLocaleString()} user stats`,
    );
  }

  let currentHits = hitsResult.hits;

  while (currentHits.length > 0) {
    for (const hit of currentHits) {
      const { id, kind, pubkey } = hit._source;
      if (kind === 0) {
        kind0PubkeyBatch.push(pubkey);
      } else {
        eventIdBatch.push(id);
      }

      // Flush when batch is full.
      if (
        eventIdBatch.length >= BATCH_SIZE ||
        kind0PubkeyBatch.length >= BATCH_SIZE
      ) {
        await flushBatch();
        logProgress();
      }
    }

    processed += currentHits.length;

    // Fetch next scroll page.
    const scrollResponse = await client.scroll({
      scroll_id: scrollId,
      scroll: SCROLL_TTL,
    });
    scrollId = scrollResponse.body._scroll_id as string;
    currentHits = (
      scrollResponse.body.hits as unknown as {
        hits: Array<{ _source: { id: string; kind: number; pubkey: string } }>;
      }
    ).hits;

    // Periodically clear fielddata cache to prevent circuit breaker.
    if (processed % 50_000 === 0) {
      await clearCache();
    }
  }

  // Flush remaining.
  await flushBatch();
  logProgress();

  // Clean up scroll context.
  try {
    await client.clearScroll({ scroll_id: scrollId });
  } catch {
    // Scroll may have already expired.
  }

  console.log(
    `\nRefresh complete: ${publishedEvents.toLocaleString()} event stats + ${publishedUsers.toLocaleString()} user stats published`,
  );

  await relay.close();
}

main().catch((error) => {
  console.error("\nNIP-85 refresh failed:", error);
  process.exit(1);
});
