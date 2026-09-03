/**
 * Backfill the `spam_score` field for existing replies.
 *
 * Unlike the other backfills this cannot be a Painless script: the value
 * comes from running the nspam LightGBM model over the note's content, which
 * only exists in this process. So the script pages documents out, scores them
 * in Bun, and writes the scores back with a bulk update.
 *
 * Scope: whatever `isScorable` accepts on the ingest path — kind 1 with an
 * `e` tag and no `q` tag, plus all kind 1111 comments — that has no
 * `spam_score` yet. Events are scored as a group of one, exactly as the
 * ingest path does, so backfilled and live scores are identical.
 *
 * Until a document is scored it has no `spam_score`, and a `range` query does
 * not match documents missing the field — so unscored events stay visible and
 * this can run incrementally against a live relay without hiding anything
 * half-way through.
 *
 * Progress is checkpointed by `created_at`, so an interrupted run resumes
 * where it stopped.
 *
 * Usage:
 *   bun run scripts/backfill-spam.ts
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import process from "node:process";

import { Config } from "../src/config.ts";
import { createSpamClassifier, isScorable } from "../src/nspam/index.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";
import type { ClientOptions } from "../src/opensearch-client.ts";
import { Client as OpenSearchClient } from "../src/opensearch-client.ts";
import { withRetry } from "./retry.ts";

const BATCH_SIZE = 1000;

const CHECKPOINT_PATH =
  process.env.BACKFILL_SPAM_CHECKPOINT ?? "/tmp/backfill-spam.checkpoint.json";

interface SpamCheckpoint {
  /** `search_after` cursor: [created_at, id] of the last processed document. */
  after: [number, string];
  scored: number;
  skipped: number;
}

function loadCheckpoint(path: string): SpamCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SpamCheckpoint;
    return Array.isArray(parsed.after) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write via a temp file and rename, so an interrupted write can't corrupt it. */
function saveCheckpoint(path: string, checkpoint: SpamCheckpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint));
  renameSync(tmp, path);
}

interface Hit {
  _source: {
    id: string;
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
  };
  sort: [number, string];
}

async function main(): Promise<void> {
  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });

  console.log("Starting spam_score backfill\n");
  console.log(`OpenSearch node: ${config.opensearchNode}`);
  console.log(`Index:           ${config.opensearchIndex}`);
  console.log(`SPAM_THRESHOLD:  ${config.spamThreshold}`);

  if (config.spamThreshold <= 0) {
    console.log(
      "\nSPAM_THRESHOLD is 0, so nothing queries spam_score. Scoring anyway —\n" +
        "the field is inert until the threshold is raised.",
    );
  }

  const clientOptions: ClientOptions = { node: config.opensearchNode };
  if (config.opensearchUsername && config.opensearchPassword) {
    clientOptions.auth = {
      username: config.opensearchUsername,
      password: config.opensearchPassword,
    };
  }
  const client = new OpenSearchClient(clientOptions);
  const relay = new OpenSearchRelay(client, {
    indexName: config.opensearchIndex,
  });

  const classifier = await createSpamClassifier();
  console.log("Model loaded.\n");

  const checkpoint = loadCheckpoint(CHECKPOINT_PATH);
  let after: [number, string] | undefined = checkpoint?.after;
  let scored = checkpoint?.scored ?? 0;
  let skipped = checkpoint?.skipped ?? 0;

  if (checkpoint) {
    console.log(
      `Resuming from created_at=${after?.[0]} (${scored} scored, ${skipped} skipped so far)\n`,
    );
  }

  // The two reply-shaped kinds, with no score yet.
  //
  // Kind 1 needs an `e` tag to be a reply at all, so that narrowing happens
  // here. Kind 1111 is a comment by definition and may have no `e` tag (a
  // comment on an article or a URL scopes with `A`/`a` or `I`/`i`), so it is
  // taken wholesale. The `q` exclusion for kind 1 is applied in-process
  // below, since it cannot be expressed as an index narrowing here without
  // also excluding kind 1111 citations. See `isScorable`.
  const query = {
    bool: {
      must: [{ term: { deleted: false } }],
      should: [
        {
          bool: {
            must: [{ term: { kind: 1 } }, { exists: { field: "tags_map.e" } }],
          },
        },
        { term: { kind: 1111 } },
      ],
      minimum_should_match: 1,
      must_not: [{ exists: { field: "spam_score" } }],
    },
  };

  const started = Date.now();

  while (true) {
    const response = await withRetry(
      () =>
        client.search<Hit["_source"]>({
          index: config.opensearchIndex,
          body: {
            query,
            size: BATCH_SIZE,
            _source: ["id", "kind", "content", "tags", "created_at"],
            sort: [{ created_at: "asc" }, { id: "asc" }],
            track_total_hits: false,
            ...(after && { search_after: after }),
          },
        }),
      {},
    );

    const hits = response.body.hits.hits as unknown as Hit[];
    if (hits.length === 0) break;

    const updates: Array<{ id: string; doc: Record<string, unknown> }> = [];
    for (const hit of hits) {
      const doc = hit._source;
      if (!isScorable({ kind: doc.kind, tags: doc.tags })) {
        skipped++;
        continue;
      }
      const score = classifier.score([
        {
          content: doc.content,
          tags: doc.tags,
          created_at: doc.created_at,
        },
      ]);
      if (!score) {
        skipped++;
        continue;
      }
      updates.push({ id: doc.id, doc: { spam_score: score.raw } });
    }

    if (updates.length > 0) {
      await withRetry(() => relay.bulkUpdateDocs(updates));
      scored += updates.length;
    }

    after = hits[hits.length - 1].sort;
    saveCheckpoint(CHECKPOINT_PATH, { after, scored, skipped });

    const elapsed = (Date.now() - started) / 1000;
    console.log(
      `scored=${scored} skipped=${skipped} ` +
        `rate=${(scored / Math.max(elapsed, 1)).toFixed(0)}/s ` +
        `at created_at=${after[0]}`,
    );
  }

  console.log(
    `\nDone. Scored ${scored} replies, skipped ${skipped} (quotes or empty).`,
  );
  console.log(
    `Documents with no spam_score are treated as unscored, not as clean.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
