/**
 * Backfill follower counts for kind 0 (profile) events.
 *
 * Aggregates kind 3 (contact list) events by their `tags_map.p` values
 * to count how many unique pubkeys follow each pubkey, then writes the
 * count into the `followers` field on the corresponding kind 0 event.
 *
 * For kind 0 events, `followers` represents follower count (the number
 * of unique kind 3 events whose `p` tags include the profile's pubkey).
 *
 * Usage:
 *   bun run scripts/backfill-followers.ts
 */

import process from "node:process";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";
import type { ClientOptions } from "../src/opensearch-client.ts";
import { Client as OpenSearchClient } from "../src/opensearch-client.ts";
import { sleep, withRetry } from "./retry.ts";

/**
 * Followed pubkeys per aggregation page, and so per `updateByQuery`.
 *
 * Each batch sends a `terms` clause and a painless params map of this size
 * and updates every matching kind 0. Larger batches mean fewer, longer
 * requests, and long requests against a 300M-document index are where Bun's
 * fetch starts returning `Malformed_HTTP_Response`. Override with
 * `--batch <n>` if a run keeps stalling on the same page.
 */
/**
 * Kind 0 versions updated per pubkey. A profile's replaced history is
 * counted too, so the field stays consistent if an older version is ever
 * surfaced; a pubkey with more versions than this keeps its oldest ones.
 */
const KIND0_VERSION_CAP = 100;

const BATCH_SIZE = (() => {
  const i = process.argv.indexOf("--batch");
  if (i === -1) return 5000;
  const value = Number(process.argv[i + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Invalid --batch: ${process.argv[i + 1]}`);
    process.exit(1);
  }
  return value;
})();

async function main() {
  console.log("Starting follower count backfill\n");

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

  // Ensure the index has the current mappings.
  const relay = new OpenSearchRelay(client, { indexName });
  await relay.migrate();
  console.log("Index mappings updated\n");

  // Phase 1: Paginated composite aggregation over kind 3 events.
  // Groups by followed pubkey (`tags_map.p`), counting the number of
  // unique kind 3 events (each kind 3 is replaceable, so one per follower).
  console.log("Computing follower counts...\n");

  let totalProcessed = 0;
  let totalUpdated = 0;
  let afterKey: Record<string, string> | undefined;

  while (true) {
    const compositeAgg: Record<string, unknown> = {
      composite: {
        size: BATCH_SIZE,
        sources: [{ followed_pubkey: { terms: { field: "tags_map.p" } } }],
        ...(afterKey && { after: afterKey }),
      },
    };

    const clearCache = async () => {
      await client.indices.clearCache({ index: indexName, fielddata: true });
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
                  { term: { replaced: false } },
                  { term: { kind: 3 } },
                ],
              },
            },
            size: 0,
            aggs: { by_pubkey: compositeAgg },
          },
        }),
      { onRetry: clearCache },
    );

    const aggResult = response.body.aggregations?.by_pubkey as {
      buckets: Array<{
        key: { followed_pubkey: string };
        doc_count: number;
      }>;
      after_key?: Record<string, string>;
    };

    const buckets = aggResult?.buckets || [];
    if (buckets.length === 0) break;

    // Build follower count map: pubkey -> follower count.
    const followerCounts = new Map<string, number>();
    for (const bucket of buckets) {
      const pubkey = bucket.key.followed_pubkey;
      // Each bucket's doc_count = number of kind 3 events that p-tag
      // this pubkey.  Since kind 3 is replaceable (one per author),
      // this equals the number of unique followers.
      followerCounts.set(pubkey, bucket.doc_count);
    }

    // Resolve each pubkey's kind 0 documents, then set the count on them by
    // id. The obvious implementation is one updateByQuery matching
    // kind 0 AND terms(pubkeys), but under Bun those long requests fail with
    // Malformed_HTTP_Response and, once a pooled connection goes bad, every
    // retry on it fails too — repeatedly killing this backfill hundreds of
    // thousands of pubkeys in, with nothing resumable behind it. Resolving
    // ids and issuing a bulk update is the path the event import drove 95M
    // documents through without a single transport failure.
    const pubkeys = [...followerCounts.keys()];

    const idsPerPubkey = await withRetry(
      () =>
        relay.queryIdsBatch(
          pubkeys.map((pubkey) => ({ kinds: [0], authors: [pubkey] })),
          { size: KIND0_VERSION_CAP },
        ),
      { onRetry: clearCache },
    );

    const updates: Array<{ id: string; doc: Record<string, unknown> }> = [];
    for (let i = 0; i < pubkeys.length; i++) {
      const followers = followerCounts.get(pubkeys[i]) ?? 0;
      for (const id of idsPerPubkey[i] ?? []) {
        updates.push({ id, doc: { followers } });
      }
    }

    if (updates.length > 0) {
      await withRetry(() => relay.bulkUpdateDocs(updates), {
        onRetry: clearCache,
      });
    }

    totalProcessed += buckets.length;
    totalUpdated += followerCounts.size;
    afterKey = aggResult.after_key;

    console.log(
      `Processed ${totalProcessed} followed pubkeys (batch: ${buckets.length})`,
    );

    if (!afterKey) break;

    // Periodically clear fielddata cache to prevent circuit breaker.
    if (totalProcessed % 5_000 === 0) {
      await client.indices.clearCache({
        index: indexName,
        fielddata: true,
      });
    }

    await sleep(200);
  }

  console.log(`\nBackfill complete:`);
  console.log(`  ${totalUpdated} pubkeys with follower counts updated`);

  await relay.close();
}

main().catch((error) => {
  console.error("\nFollower count backfill failed:", error);
  process.exit(1);
});
