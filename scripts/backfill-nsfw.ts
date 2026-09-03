/**
 * Backfill script to populate the `nsfw` field for existing documents.
 *
 * An event is NSFW when it has a media attachment AND an NSFW hashtag (see
 * src/nsfw.ts) — the same rule the ingest path applies. Documents indexed
 * before the field existed read as not-nsfw under the NIP-50 `nsfw:false`
 * extension, so this script flags them retroactively.
 *
 * Scope: documents with `media: true` and at least one `t` tag, not already
 * flagged. Hashtag matching is case-insensitive, so the Painless script
 * lowercases the raw `t` tag values itself (tags_map stores them verbatim);
 * documents whose hashtags don't match are noops.
 *
 * The hashtag set is taken from config (`NSFW_HASHTAGS`, defaulting to
 * `DEFAULT_NSFW_HASHTAGS`), so run this with the same environment as the
 * relay.
 *
 * Usage:
 *   bun run scripts/backfill-nsfw.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

const PAINLESS_SCRIPT = `
boolean match = false;
for (def tag : ctx._source.tags) {
  if (tag.size() >= 2 && tag[0] == 't' && params.nsfw.contains(tag[1].toLowerCase())) {
    match = true;
    break;
  }
}
if (match) {
  ctx._source.nsfw = true;
} else {
  ctx.op = 'noop';
}
`.trim();

async function main() {
  console.log("Starting nsfw backfill\n");

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${config.opensearchIndex}`);
  console.log(`NSFW hashtags: ${[...config.nsfwHashtags].join(", ")}\n`);

  if (config.nsfwHashtags.size === 0) {
    console.log("NSFW_HASHTAGS is empty — nothing to classify.");
    return;
  }

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

  const query = {
    bool: {
      must: [{ term: { media: true } }, { exists: { field: "tags_map.t" } }],
      must_not: [{ term: { nsfw: true } }],
    },
  };

  try {
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: { query },
    });

    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} candidate documents (media + hashtags, not yet flagged).\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    console.log("Running update_by_query (this may take a while)...\n");

    const taskResponse = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        query,
        script: {
          source: PAINLESS_SCRIPT,
          lang: "painless",
          params: { nsfw: [...config.nsfwHashtags] },
        },
      },
      conflicts: "proceed",
      scroll_size: 1000,
      wait_for_completion: false,
      requests_per_second: -1,
    });

    const taskId = (taskResponse.body as unknown as { task: string }).task;
    console.log(`Task started: ${taskId}\n`);

    // Poll for task completion
    let completed = false;
    while (!completed) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const statusResponse = await client.tasks.get({ task_id: taskId });
      const task = statusResponse.body.task as {
        status: {
          total: number;
          updated: number;
          version_conflicts: number;
          noops: number;
        };
      };
      const status = task.status;

      const pct =
        status.total > 0
          ? ((status.updated / status.total) * 100).toFixed(2)
          : "0.00";

      const parts = [
        `Updated ${status.updated.toLocaleString()} / ${status.total.toLocaleString()} (${pct}%)`,
      ];
      if (status.version_conflicts > 0) {
        parts.push(`${status.version_conflicts} conflicts`);
      }
      if (status.noops > 0) {
        parts.push(`${status.noops} noops`);
      }
      console.log(parts.join(" | "));

      completed = statusResponse.body.completed as boolean;
    }

    // Get final result
    const finalResponse = await client.tasks.get({ task_id: taskId });
    const response = finalResponse.body.response as {
      total: number;
      updated: number;
      version_conflicts: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(
      `\nUpdated ${response.updated.toLocaleString()} of ${response.total.toLocaleString()} documents`,
    );

    if (response.version_conflicts > 0) {
      console.log(
        `  ${response.version_conflicts} version conflicts (skipped)`,
      );
    }

    if (response.failures && response.failures.length > 0) {
      console.error(`  ${response.failures.length} documents failed to update`);
      for (const failure of response.failures.slice(0, 5)) {
        console.error(`  ${JSON.stringify(failure)}`);
      }
      if (response.failures.length > 5) {
        console.error(
          `    ... and ${response.failures.length - 5} more failures`,
        );
      }
    }

    console.log("\nBackfill completed successfully");
  } catch (error) {
    console.error("\nBackfill failed:");
    if (error && typeof error === "object" && "meta" in error) {
      const meta = (error as { meta?: { body?: unknown } }).meta;
      console.error(JSON.stringify(meta?.body, null, 2));
    } else {
      console.error(error);
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
