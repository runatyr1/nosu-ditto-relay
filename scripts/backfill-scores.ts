/**
 * Backfill engagement scores for all existing events.
 *
 * Paginates through referenced event IDs using composite aggregation on
 * `tags_map.e`. Each batch of IDs gets engagement, zap, and quote
 * aggregations run against it, then a single bulk update writes all
 * scores. Nothing accumulates across batches.
 *
 * Events that have never been referenced get no update (their scores
 * remain at 0, which is correct).
 *
 * Usage:
 *   bun run scripts/backfill-scores.ts
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";
import type { ClientOptions } from "../src/opensearch-client.ts";
import { Client as OpenSearchClient } from "../src/opensearch-client.ts";
import { withRetry } from "./retry.ts";

const BATCH_SIZE = 10000;

/** Where the composite cursor is parked between pages. */
const CHECKPOINT_PATH =
  process.env.BACKFILL_SCORES_CHECKPOINT ??
  "/tmp/backfill-scores.checkpoint.json";

interface ScoresCheckpoint {
  afterKey: Record<string, string>;
  processed: number;
}

/** Read the cursor from a previous run, or null to start from the top. */
function loadCheckpoint(path: string): ScoresCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ScoresCheckpoint;
    return parsed.afterKey ? parsed : null;
  } catch {
    return null;
  }
}

/** Park the cursor, atomically so a crash can't leave it truncated. */
function saveCheckpoint(path: string, checkpoint: ScoresCheckpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint));
  renameSync(tmp, path);
}

/** Drop the cursor once the pass has finished. */
function clearCheckpoint(path: string): void {
  rmSync(path, { force: true });
}

/** Check if a string is a valid 64-char lowercase hex event ID. */
function isValidEventId(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

interface ScoreEntry {
  engagers: number;
  comment_cnt: number;
  reaction_cnt: number;
  repost_cnt: number;
  quote_cnt: number;
  zap_amount_msats: number;
  zap_cnt: number;
}

async function main() {
  console.log("Starting scores backfill\n");

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

  // Ensure the index has the new score field mappings.
  const relay = new OpenSearchRelay(client, { indexName });
  await relay.migrate();
  console.log("Index mappings updated\n");

  const clearCache = async () => {
    await client.indices.clearCache({ index: indexName, fielddata: true });
  };

  // Paginated composite aggregation over engagement events.
  // Groups by referenced event ID (`tags_map.e`), computes unique authors,
  // and breaks down by kind.
  console.log("Computing scores...\n");

  // A full pass is ~96M referenced events and takes days, so the composite
  // cursor is checkpointed after every page. Without it any failure — the
  // relay restarting, a broken connection outliving its retries — throws the
  // whole run away and starts from the first bucket again.
  const checkpoint = loadCheckpoint(CHECKPOINT_PATH);
  let totalProcessed = checkpoint?.processed ?? 0;
  let afterKey: Record<string, string> | undefined = checkpoint?.afterKey;

  if (checkpoint) {
    console.log(`Resuming after ${totalProcessed} events\n`);
  }

  while (true) {
    const compositeAgg: Record<string, unknown> = {
      composite: {
        size: BATCH_SIZE,
        sources: [{ event_id: { terms: { field: "tags_map.e" } } }],
        ...(afterKey && { after: afterKey }),
      },
      aggs: {
        unique_authors: { cardinality: { field: "pubkey" } },
        by_kind: { terms: { field: "kind", size: 10 } },
      },
    };

    const response = await withRetry(
      () =>
        client.search({
          index: indexName,
          body: {
            query: {
              bool: {
                must: [
                  { term: { deleted: false } },
                  { terms: { kind: [1, 6, 7, 16, 1111] } },
                ],
              },
            },
            size: 0,
            aggs: { by_event: compositeAgg },
          },
        }),
      { onRetry: clearCache },
    );

    const aggResult = response.body.aggregations?.by_event as {
      buckets: Array<{
        key: { event_id: string };
        doc_count: number;
        unique_authors?: { value: number };
        by_kind?: { buckets?: Array<{ key: number; doc_count: number }> };
      }>;
      after_key?: Record<string, string>;
    };

    const buckets = aggResult?.buckets || [];
    if (buckets.length === 0) break;

    // Build scores from engagement aggregation.
    const scores = new Map<string, ScoreEntry>();
    const validIds: string[] = [];

    for (const bucket of buckets) {
      const id = bucket.key.event_id;
      if (!isValidEventId(id)) continue;

      validIds.push(id);

      const entry: ScoreEntry = {
        engagers: bucket.unique_authors?.value ?? 0,
        comment_cnt: 0,
        reaction_cnt: 0,
        repost_cnt: 0,
        quote_cnt: 0,
        zap_amount_msats: 0,
        zap_cnt: 0,
      };

      for (const kb of bucket.by_kind?.buckets || []) {
        switch (kb.key) {
          case 1:
          case 1111:
            entry.comment_cnt += kb.doc_count;
            break;
          case 7:
            entry.reaction_cnt += kb.doc_count;
            break;
          case 6:
          case 16:
            entry.repost_cnt += kb.doc_count;
            break;
        }
      }

      scores.set(id, entry);
    }

    // Scoped zap and quote aggregations for this batch's event IDs.
    if (validIds.length > 0) {
      const [zapResponse, quoteResponse] = await Promise.all([
        withRetry(
          () =>
            client.search({
              index: indexName,
              body: {
                query: {
                  bool: {
                    must: [
                      { term: { deleted: false } },
                      { term: { kind: 9735 } },
                      { terms: { "tags_map.e": validIds } },
                    ],
                  },
                },
                size: 0,
                aggs: {
                  by_event: {
                    terms: {
                      field: "tags_map.e",
                      size: validIds.length,
                      include: validIds,
                    },
                    aggs: {
                      total_msats: { sum: { field: "amount_msats" } },
                    },
                  },
                },
              },
            }),
          { onRetry: clearCache },
        ),
        withRetry(
          () =>
            client.search({
              index: indexName,
              body: {
                query: {
                  bool: {
                    must: [
                      { term: { deleted: false } },
                      { term: { kind: 1 } },
                      { terms: { "tags_map.q": validIds } },
                    ],
                  },
                },
                size: 0,
                aggs: {
                  by_event: {
                    terms: {
                      field: "tags_map.q",
                      size: validIds.length,
                      include: validIds,
                    },
                  },
                },
              },
            }),
          { onRetry: clearCache },
        ),
      ]);

      // Merge zap scores.
      const zapBuckets =
        (
          zapResponse.body.aggregations?.by_event as {
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

      // Merge quote scores.
      const quoteBuckets =
        (
          quoteResponse.body.aggregations?.by_event as {
            buckets?: Array<{
              key: string;
              doc_count: number;
            }>;
          }
        )?.buckets || [];

      for (const bucket of quoteBuckets) {
        const s = scores.get(bucket.key);
        if (s) {
          s.quote_cnt = bucket.doc_count;
        }
      }
    }

    // Single bulk update for all score fields (doc IDs are hex event IDs).
    const body: Array<Record<string, unknown>> = [];

    for (const [id, s] of scores) {
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

    if (body.length > 0) {
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

    totalProcessed += buckets.length;
    afterKey = aggResult.after_key;

    console.log(
      `Processed ${totalProcessed} referenced events (batch: ${buckets.length})`,
    );

    if (!afterKey) break;

    saveCheckpoint(CHECKPOINT_PATH, { afterKey, processed: totalProcessed });

    // Periodically clear fielddata cache to prevent circuit breaker.
    if (totalProcessed % 50_000 === 0) {
      await clearCache();
    }
  }

  clearCheckpoint(CHECKPOINT_PATH);
  console.log(`\nBackfill complete: ${totalProcessed} events processed`);

  await relay.close();
}

main().catch((error) => {
  console.error("\nScores backfill failed:", error);
  process.exit(1);
});
