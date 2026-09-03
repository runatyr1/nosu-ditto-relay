/**
 * Indexer worker — the single owner of all OpenSearch writes.
 *
 * Protocol workers send write requests (event indexing, deletions) over
 * dedicated MessageChannel ports (one per protocol worker, transferred by
 * the pool at spawn) so indexing traffic bypasses the main thread entirely.
 * Centralizing writes keeps bulk batches coalesced across all connections
 * and gives replaceable-slot resolution (phase 2) a single writer instead
 * of N racing ones.
 *
 * Dirty-reference tracking for the background stats worker also lives here
 * (it is fed by bulk flushes), forwarded to the main thread every 2s.
 */

declare var self: Worker;

import process from "node:process";

import { Config } from "./config.ts";
import { StorageOverloaded } from "./errors.ts";
import type {
  FromIndexerWorker,
  IndexerBatch,
  IndexerReply,
  IndexerRequest,
  ToIndexerWorker,
} from "./indexer-client.ts";
import { Logger } from "./log.ts";
import { register, startRuntimeMetrics } from "./metrics.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type { ClientOptions } from "./opensearch-client.ts";
import { Client as OpenSearchClient } from "./opensearch-client.ts";
// Installs a buffering `self.onmessage` at import time, so a port posted by
// the pool before this module finishes evaluating can't be dropped.
import { onWorkerMessage } from "./worker-inbox.ts";

// ---------------------------------------------------------------------------
// Initialise from environment (same .env as the main process)
// ---------------------------------------------------------------------------

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

const log = new Logger(config.logLevel);

const opensearchClientOptions: ClientOptions = {
  node: config.opensearchNode,
};
if (config.opensearchUsername && config.opensearchPassword) {
  opensearchClientOptions.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}

// Reads here are phase-2 slot lookups and deletion queries — low volume,
// but still split from the write client so bulk flushes can't starve them.
const opensearchRelay = new OpenSearchRelay(
  new OpenSearchClient(opensearchClientOptions),
  {
    ...OpenSearchRelay.optionsFromConfig(config),
    writeClient: new OpenSearchClient(opensearchClientOptions),
    bulkMaxQueue: config.bulkMaxQueue,
    logger: log,
  },
);

// ---------------------------------------------------------------------------
// Dirty-reference forwarding for the background stats worker
// ---------------------------------------------------------------------------

if (config.statsEnabled) {
  const pendingDirtyAddrs = new Set<string>();
  const pendingDirtyIdentifiers = new Set<string>();
  opensearchRelay.onDirtyAddrs = (addrs) => {
    for (const addr of addrs) pendingDirtyAddrs.add(addr);
  };
  opensearchRelay.onDirtyIdentifiers = (ids) => {
    for (const id of ids) pendingDirtyIdentifiers.add(id);
  };

  setInterval(() => {
    const dirty = opensearchRelay.drainDirty();
    const addrs = [...pendingDirtyAddrs];
    pendingDirtyAddrs.clear();
    const identifiers = [...pendingDirtyIdentifiers];
    pendingDirtyIdentifiers.clear();

    if (
      dirty.ids.length === 0 &&
      dirty.pubkeys.length === 0 &&
      addrs.length === 0 &&
      identifiers.length === 0
    ) {
      return;
    }

    self.postMessage({
      t: "dirty",
      ids: dirty.ids,
      pubkeys: dirty.pubkeys,
      addrs,
      identifiers,
    } satisfies FromIndexerWorker);
  }, 2_000);
}

// ---------------------------------------------------------------------------
// Port handling — one MessageChannel port per protocol worker
// ---------------------------------------------------------------------------

function attachPort(port: MessagePort): void {
  // Per-port reply batching: replies that settle in the same tick (e.g. a
  // whole bulk flush resolving) go back in one postMessage.
  let replies: IndexerReply[] = [];
  let flushScheduled = false;

  function queueReply(reply: IndexerReply): void {
    replies.push(reply);
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(() => {
        flushScheduled = false;
        if (replies.length > 0) {
          port.postMessage({ t: "replies", items: replies });
          replies = [];
        }
      });
    }
  }

  function settle(reqId: number, work: Promise<void>): void {
    work.then(
      () => queueReply({ reqId }),
      (error) => {
        if (error instanceof StorageOverloaded) {
          queueReply({
            reqId,
            err: { code: "overloaded", message: error.message },
          });
        } else {
          queueReply({
            reqId,
            err: {
              code: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      },
    );
  }

  function handle(item: IndexerRequest): void {
    switch (item.t) {
      case "index":
        // event() can throw StorageOverloaded synchronously (bulk queue
        // cap); normalize through the same settle path.
        try {
          settle(
            item.reqId,
            opensearchRelay.event(item.event, { analysis: item.analysis }),
          );
        } catch (error) {
          settle(item.reqId, Promise.reject(error));
        }
        break;
      case "remove":
        settle(
          item.reqId,
          opensearchRelay.remove(item.filters, {
            excludeKinds: item.excludeKinds,
          }),
        );
        break;
    }
  }

  // Note: untyped param — Bun and undici both declare a global MessageEvent
  // and they disagree; let TS infer from the setter.
  port.onmessage = (event) => {
    const batch = event.data as IndexerBatch;
    for (const item of batch.items) {
      handle(item);
    }
  };
}

// ---------------------------------------------------------------------------
// Main-thread channel: ports in, metrics/dirty out
// ---------------------------------------------------------------------------

onWorkerMessage<ToIndexerWorker>((event) => {
  const msg = event.data;
  switch (msg.t) {
    case "port":
      attachPort(msg.port);
      break;
    case "metrics":
      register.metrics().then((text) => {
        self.postMessage({
          t: "metrics",
          reqId: msg.reqId,
          text,
        } satisfies FromIndexerWorker);
      });
      break;
  }
});

self.postMessage({ t: "ready" } satisfies FromIndexerWorker);

// Sample this worker's event-loop lag for /metrics (memory is process-wide
// and reported by the main thread).
startRuntimeMetrics(5_000, { memory: false });

log.info("indexer_worker_started");
