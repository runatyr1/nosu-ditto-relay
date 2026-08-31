/**
 * Background worker for score recomputation, NIP-85 publishing, and trends.
 *
 * Runs on a separate thread so that heavy OpenSearch aggregation queries
 * don't block the main event loop that serves WebSocket REQ/EVENT traffic.
 *
 * Configuration comes from the environment, not from the main thread — this
 * worker reads the same .env as the parent process.
 *
 * Communication protocol:
 * - Main → Worker:  { type: "dirty", ids: string[], pubkeys: string[], addrs: string[], identifiers: string[] }
 * - Worker → Main:  { type: "broadcast", events: string[] } — serialized
 *   NostrEvent JSON, stringified here so the main thread only moves strings
 *   (a recompute tick can emit hundreds of NIP-85 stat events).
 */

import process from "node:process";
import type { NostrEvent } from "nostr-tools";
import { Config } from "./config.ts";
import { errFields, Logger } from "./log.ts";
import { Nip85 } from "./nip85.ts";
import { OpenSearchRelay, type TrustProvider } from "./opensearch.ts";
import { Client as OpenSearchClient } from "./opensearch-client.ts";
import { Trends } from "./trends.ts";
// Installs a buffering `self.onmessage` at import time, so dirty batches
// posted before this module finishes evaluating can't be dropped.
import { onWorkerMessage } from "./worker-inbox.ts";
import { Wot } from "./wot.ts";

declare var self: Worker;

/** Dirty references forwarded by the main thread (drained from the indexer). */
interface DirtyMessage {
  type: "dirty";
  ids: string[];
  pubkeys: string[];
  addrs: string[];
  identifiers: string[];
}

// ---------------------------------------------------------------------------
// Initialise from environment (same .env as main process)
// ---------------------------------------------------------------------------

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// This worker is its own entry point (separate thread), so it constructs its
// own Logger from the same env-derived config as the main process.
const log = new Logger(config.logLevel);

const clientOptions = {
  node: config.opensearchNode,
  ...(config.opensearchUsername &&
    config.opensearchPassword && {
      auth: {
        username: config.opensearchUsername,
        password: config.opensearchPassword,
      },
    }),
};

const readClient = new OpenSearchClient(clientOptions);
const writeClient = new OpenSearchClient(clientOptions);

const relay = new OpenSearchRelay(readClient, {
  indexName: config.opensearchIndex,
  historyEnabled: config.historyEnabled,
  historyKindsWhitelist: config.historyKindsWhitelist,
  historyKindsExcluded: config.historyKindsExcluded,
  authKinds: config.authKinds,
  writeClient,
  tagValueMaxCountPerName: config.tagValueMaxCountPerName,
  logger: log,
});

const signer = config.nostrSigner;

// ---------------------------------------------------------------------------
// Web of trust (optional, only with configured seeds)
//
// Expanded from WOT_SEED_PUBKEYS via kind 3 contact lists in the local
// index. While active, only trusted pubkeys count toward engagement scores
// and trends — the sybil-resistance layer for sort:hot/top and trending.
// The provider returns undefined until the first refresh completes, so
// early recompute ticks fall back to unfiltered counting rather than
// zeroing every score.
// ---------------------------------------------------------------------------

const WOT_REFRESH_INTERVAL_MS = 3_600_000;

let trustProvider: TrustProvider | undefined;
if (config.wotSeedPubkeys.size > 0) {
  const wot = new Wot({
    relay,
    seeds: config.wotSeedPubkeys,
    logger: log,
  });
  trustProvider = () => wot.trusted();
  relay.trustProvider = trustProvider;

  /** Guards against overlapping refreshes, as in the loops below. */
  let wotInFlight = false;
  /** Set once after the first successful refresh (re-dirty trigger). */
  let wotSeeded = false;

  const refreshWot = () => {
    if (wotInFlight) {
      log.debug("wot_refresh_skipped_overlap");
      return;
    }
    wotInFlight = true;
    wot
      .refresh()
      .then(async () => {
        // Scores computed before trust filtering became active are stale
        // (sybil-inflated); re-dirty the most-engaged recent events once
        // so the next recompute ticks rewrite them under the WoT.
        if (!wotSeeded) {
          wotSeeded = true;
          const count = await relay.seedDirtyEngaged();
          log.info("wot_seeded_dirty", { count });
        }
      })
      .catch((err) => log.error("wot_refresh_failed", errFields(err)))
      .finally(() => {
        wotInFlight = false;
      });
  };

  refreshWot();
  setInterval(refreshWot, WOT_REFRESH_INTERVAL_MS);

  log.info("wot_scheduled", {
    seeds: config.wotSeedPubkeys.size,
    interval_ms: WOT_REFRESH_INTERVAL_MS,
  });
}

/**
 * Post a NostrEvent back to the main thread for WebSocket broadcast.
 *
 * Serialized here (off-main) and batched per event-loop tick: a recompute
 * tick publishes one kind 30382/30383 per dirty pubkey/event — hundreds on
 * a busy relay — so one postMessage per event would clone-storm the main
 * thread. Same setImmediate coalescing pattern as the protocol workers.
 */
let pendingBroadcasts: string[] = [];
let broadcastFlushScheduled = false;

function broadcastToMain(event: NostrEvent): void {
  pendingBroadcasts.push(JSON.stringify(event));
  if (!broadcastFlushScheduled) {
    broadcastFlushScheduled = true;
    setImmediate(() => {
      broadcastFlushScheduled = false;
      if (pendingBroadcasts.length > 0) {
        self.postMessage({ type: "broadcast", events: pendingBroadcasts });
        pendingBroadcasts = [];
      }
    });
  }
}

const nip85 = new Nip85({
  client: readClient,
  indexName: config.opensearchIndex,
  relay,
  signer,
  broadcast: broadcastToMain,
  logger: log,
});

// Trends (optional, only if interval > 0).
const trendsIntervalMs = config.trendsIntervalMs;
let trends: Trends | undefined;
if (trendsIntervalMs > 0) {
  trends = new Trends({
    client: readClient,
    indexName: config.opensearchIndex,
    relay,
    broadcast: broadcastToMain,
    trustProvider,
  });
}

// ---------------------------------------------------------------------------
// Message handler — receives dirty sets from the indexer via the main thread
//
// Event IDs and pubkeys go straight into the relay's own pending sets, which
// already apply OpenSearchRelay.MAX_PENDING_DIRTY and log on overflow.
// recomputeScores() drains them.
// ---------------------------------------------------------------------------

onWorkerMessage<DirtyMessage>((event) => {
  const msg = event.data;

  if (msg.type === "dirty") {
    relay.addDirtyIds(msg.ids);
    relay.addDirtyPubkeys(msg.pubkeys);
    if (msg.addrs.length > 0) nip85.addDirtyAddrs(new Set(msg.addrs));
    if (msg.identifiers.length > 0)
      nip85.addDirtyIdentifiers(new Set(msg.identifiers));
  }
});

// ---------------------------------------------------------------------------
// Score recomputation loop — runs every 5s
// ---------------------------------------------------------------------------

const SCORE_RECOMPUTE_INTERVAL_MS = 5_000;

async function recomputeLoop(): Promise<void> {
  try {
    // A no-op when nothing is dirty: recomputeScores() reports count 0.
    const result = await relay.recomputeScores();
    if (result.count > 0) {
      await Promise.all([
        nip85.publishUserStats(result.userScores),
        nip85.publishEventStats(result.eventScores),
      ]);
    }
    // NIP-85 addr/identifier stats accumulate independently of dirty
    // events, so flush them on every tick.
    await nip85.flushAddrStats();
    await nip85.flushIdentifierStats();
  } catch (err) {
    log.error("recompute_failed", errFields(err));
  }
}

/** Guards against overlapping ticks; see the comment in the timer below. */
let recomputeInFlight = false;

setInterval(() => {
  // The interval is a floor, not a guarantee: a large dirty set takes longer
  // than one tick to process. Without this guard, slow ticks overlap and pile
  // concurrent aggregations onto OpenSearch, which makes every subsequent tick
  // slower still.
  if (recomputeInFlight) {
    log.debug("recompute_skipped_overlap");
    return;
  }
  recomputeInFlight = true;
  recomputeLoop()
    .catch((err) => log.error("recompute_loop_error", errFields(err)))
    .finally(() => {
      recomputeInFlight = false;
    });
}, SCORE_RECOMPUTE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Trends loop (optional)
// ---------------------------------------------------------------------------

if (trends) {
  // Narrowed const so the closure below doesn't need non-null assertions.
  const t = trends;
  const relayUrl = config.relayUrl;
  const preferredLanguages = config.preferredLanguages;

  const updateAllTrends = async () => {
    log.info("trends_updating");
    await t.updateTrendingHashtags(signer);
    await t.updateTrendingLinks(signer);
    await t.updateTrendingPubkeys(signer, relayUrl);
    await t.updateTrendingEvents(signer, relayUrl);
    await t.updateTrendingZappedEvents(signer, relayUrl);
    if (preferredLanguages.length > 0) {
      await t.updateTrendingEventsByLanguage(
        signer,
        relayUrl,
        preferredLanguages,
      );
    }
    log.info("trends_updated");
  };

  /** Guards against overlapping trend updates, as in the recompute loop. */
  let trendsInFlight = false;

  setInterval(() => {
    if (trendsInFlight) {
      log.debug("trends_skipped_overlap");
      return;
    }
    trendsInFlight = true;
    updateAllTrends()
      .catch((err) => log.error("trends_update_failed", errFields(err)))
      .finally(() => {
        trendsInFlight = false;
      });
  }, trendsIntervalMs);

  log.info("trends_scheduled", {
    interval_ms: trendsIntervalMs,
    languages:
      preferredLanguages.length > 0 ? preferredLanguages.join(",") : undefined,
  });
}

log.info("bg_worker_started");
