/**
 * Protocol worker — owns connections and does all per-message work.
 *
 * Each protocol worker runs a full Relay instance: JSON parse, zod
 * validation, signature verification + analysis (inline via analyze.ts —
 * no extra thread hop), policy checks, OpenSearch reads/writes through its
 * own clients, NIP-42 auth state, NIP-77 negentropy sessions, broadcast
 * matching for its own connections, and NIP-01 frame building.
 *
 * The main thread only routes strings (see protocol-pool.ts). Outbound
 * frames are batched per event-loop tick into a single postMessage, so a
 * large REQ response costs one structured clone of an array of strings
 * instead of one postMessage per event.
 *
 * Locally-accepted events are posted back to main (batched) for fan-out to
 * sibling workers; events arriving from siblings come in as `bcast` and go
 * straight to Relay.broadcast (local matching only — no re-fan-out, so no
 * loops).
 */

declare var self: Worker;

import process from "node:process";
import type { NostrEvent } from "nostr-tools";

import { createAnalyzer } from "./analyze.ts";
import { Config } from "./config.ts";
import { IndexerClient } from "./indexer-client.ts";
import { errFields, Logger } from "./log.ts";
import { register, startRuntimeMetrics } from "./metrics.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type { ClientOptions } from "./opensearch-client.ts";
import { Client as OpenSearchClient } from "./opensearch-client.ts";
import type { FromProtocolWorker, ToProtocolWorker } from "./protocol-pool.ts";
import {
  type AnalyzableRelay,
  createConnData,
  Relay,
  type RelayConn,
  type SyncableStorage,
} from "./relay.ts";
// Installs a buffering `self.onmessage` at import time. Load-bearing: the
// top-level `await`s below suspend this module's evaluation, and messages
// arriving in that window are dropped if no handler is installed yet.
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
// Reads only: this worker's OpenSearchRelay serves REQ/COUNT/negentropy
// queries. All writes go through the IndexerClient to the single indexer
// worker, so no write client is needed here.
const opensearchReadClient = new OpenSearchClient(opensearchClientOptions);

const opensearchRelay = new OpenSearchRelay(opensearchReadClient, {
  indexName: config.opensearchIndex,
  historyEnabled: config.historyEnabled,
  historyKindsWhitelist: config.historyKindsWhitelist,
  historyKindsExcluded: config.historyKindsExcluded,
  authKinds: config.authKinds,
  tagValueMaxCountPerName: config.tagValueMaxCountPerName,
  logger: log,
});

// Write half of storage: RPC to the indexer worker over a MessageChannel
// port (transferred by the pool right after spawn — see "indexer_port"
// below). The pending cap mirrors the indexer's bulk queue cap so
// StorageOverloaded backpressure semantics are unchanged.
const indexer = new IndexerClient({ maxPending: config.bulkMaxQueue });

/**
 * The storage the Relay sees: reads answered locally, writes forwarded to
 * the indexer worker. `event()` still resolves only when the indexer's
 * bulk flush confirms the write, so OK responses reflect durability.
 */
const storage: AnalyzableRelay & SyncableStorage = {
  query: (filters, opts) => opensearchRelay.query(filters, opts),
  count: (filters, opts) => opensearchRelay.count(filters, opts),
  queryItems: (filter, opts) => opensearchRelay.queryItems(filter, opts),
  event: (event, opts) => indexer.event(event, opts?.analysis),
  remove: (filters, opts) => indexer.remove(filters, opts),
};

// Signature verification + language/sentiment/media analysis runs inline on
// this thread. The wasm verify is the dominant cost (~fraction of a ms) and
// is sharded across protocol workers, so an EVENT never pays a cross-thread
// round trip for analysis.
const analyze = await createAnalyzer({ nsfwHashtags: config.nsfwHashtags });

// ---------------------------------------------------------------------------
// Outbound batching: frames and accepted-event fan-out
// ---------------------------------------------------------------------------

let pendingFrames: Array<[id: number, frame: string]> = [];
/** Accepted events awaiting fan-out, pre-serialized so main only moves strings. */
let pendingAccepted: string[] = [];
let outFlushScheduled = false;

function scheduleOutFlush(): void {
  if (outFlushScheduled) return;
  outFlushScheduled = true;
  setImmediate(flushOut);
}

function flushOut(): void {
  outFlushScheduled = false;
  if (pendingFrames.length > 0) {
    self.postMessage({
      t: "frames",
      frames: pendingFrames,
    } satisfies FromProtocolWorker);
    pendingFrames = [];
  }
  if (pendingAccepted.length > 0) {
    self.postMessage({
      t: "accepted",
      events: pendingAccepted,
    } satisfies FromProtocolWorker);
    pendingAccepted = [];
  }
}

// ---------------------------------------------------------------------------
// Relay + connection registry
// ---------------------------------------------------------------------------

const relay = new Relay(storage, {
  analyze: (event, opts) => analyze(event, opts),
  logger: log,
  relayUrl: config.relayUrl,
  authKinds: config.authKinds,
  authorExemptKinds: config.authorExemptKinds,
  masterPubkeys: config.masterPubkeys,
  maxMessageLength: config.maxMessageLength,
  maxFilterValues: config.maxFilterValues,
  maxLimit: config.maxLimit,
  defaultLimit: config.defaultLimit,
  maxEventTags: config.tagValueMaxCountPerName,
  maxInflightPerConn: config.maxInflightPerConn,
  bannedHashtags: config.bannedHashtags,
  rejectedKinds: config.rejectedKinds,
  negentropyMaxRecords: config.negentropyMaxRecords,
  onEventAccepted: (event) => {
    // Serialize here (off-main): main forwards the string verbatim to
    // sibling workers, which parse it. Structured-cloning the event object
    // would make main re-serialize it once per sibling.
    pendingAccepted.push(JSON.stringify(event));
    scheduleOutFlush();
  },
  relayInfo: {
    pubkey: config.relayPubkey,
    contact: config.relayContact,
    self: await config.nostrSigner.getPublicKey(),
    icon: new URL("/icon.png", config.publicUrl).toString(),
    banner: new URL("/banner.jpg", config.publicUrl).toString(),
  },
});

const conns = new Map<number, RelayConn>();

function openConn(id: number, ip?: string, userAgent?: string): void {
  const conn: RelayConn = {
    id,
    data: createConnData({ ip, userAgent }),
    send: (frame) => {
      pendingFrames.push([id, frame]);
      scheduleOutFlush();
    },
  };
  conns.set(id, conn);
  relay.handleOpen(conn);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

onWorkerMessage<ToProtocolWorker>((event) => {
  const msg = event.data;
  switch (msg.t) {
    case "indexer_port":
      indexer.bind(msg.port);
      break;

    case "open":
      openConn(msg.id, msg.ip, msg.ua);
      break;

    case "msgs":
      for (const [id, data] of msg.msgs) {
        const conn = conns.get(id);
        if (!conn) continue; // closed while the batch was in flight
        // Fire-and-forget, same as the single-threaded server: awaiting
        // would serialize processing per batch and stall other connections
        // in it. Relay.handleMessage converts its own errors to NOTICEs.
        relay.handleMessage(conn, data).catch((err) => {
          log.error("message_unhandled", errFields(err));
        });
      }
      break;

    case "close": {
      const conn = conns.get(msg.id);
      if (conn) {
        conns.delete(msg.id);
        relay.handleCloseConnection(conn);
      }
      break;
    }

    case "bcast":
      // Events accepted by sibling workers (or injected by the background
      // stats worker), as serialized JSON: parse here, match against local
      // subscriptions only. A parse failure must not kill the worker (an
      // exception escaping onmessage terminates the thread), so guard it —
      // the strings come from trusted siblings, but cheap insurance.
      for (const serialized of msg.events) {
        try {
          relay.broadcast(JSON.parse(serialized) as NostrEvent);
        } catch (err) {
          log.error("bcast_parse_failed", errFields(err));
        }
      }
      break;

    case "metrics":
      register.metrics().then((text) => {
        self.postMessage({
          t: "metrics",
          reqId: msg.reqId,
          text,
        } satisfies FromProtocolWorker);
      });
      break;
  }
});

// Signal readiness with the relay info document (identical across workers).
// The pool waits for this before routing connections — and before
// terminating, since tearing down a worker mid-initialization can segfault
// Bun.
self.postMessage({
  t: "ready",
  relayInfo: relay.getRelayInfo(),
} satisfies FromProtocolWorker);

// Sample this worker's event-loop lag for /metrics — the per-worker signal
// for detecting a hot or wedged protocol worker. Memory is skipped: RSS is
// process-wide and the main thread already reports it.
startRuntimeMetrics(5_000, { memory: false });

log.info("protocol_worker_started");
