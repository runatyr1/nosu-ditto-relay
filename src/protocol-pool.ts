/**
 * ProtocolPool — main-thread bridge to the protocol workers.
 *
 * The pool owns N protocol workers (protocol-worker.ts). Each worker runs a
 * full Relay instance and owns every bit of per-connection protocol state
 * for the connections assigned to it. Connections are sticky: a connection
 * is assigned to the least-loaded worker at open time and never moves, which
 * preserves per-connection message ordering (worker channels are FIFO).
 *
 * The main thread's job is deliberately dumb: forward raw inbound message
 * strings to the owning worker, and deliver finished NIP-01 frame strings
 * coming back to the right socket. Strings cross the thread boundary as
 * flat copies — no object graphs, no parsing, no serialization on main.
 *
 * Inbound messages are batched per worker per event-loop tick (a
 * setImmediate flush) so a busy tick costs one postMessage per worker
 * instead of one per message.
 *
 * Broadcast fan-out: when a worker accepts an EVENT it posts the event to
 * main *as a serialized JSON string* (stringified once, off-main), and main
 * forwards it verbatim to every *other* worker so their connections'
 * subscriptions get matched too — the receiving worker parses. Events
 * injected from outside the pool (e.g. the background stats worker's trend
 * events) go to *all* workers via {@link broadcastExternal}.
 */

import process from "node:process";

import type { NostrRelayInfo } from "@nostrify/nostrify";

import type { FromIndexerWorker, ToIndexerWorker } from "./indexer-client.ts";
import { errFields, Logger } from "./log.ts";

/**
 * Crash-loop guard: if workers (protocol or indexer) die this many times
 * within {@link CRASH_LOOP_WINDOW_MS}, the pool gives up and exits the
 * process instead of respawning forever. Immediate respawn is the right
 * call for a rare poison-pill crash (the offending connection is closed
 * before the slot respawns), but a *deterministic* startup failure would
 * otherwise spin spawning workers at full CPU while serving nothing —
 * exiting hands the problem to the supervisor (systemd), whose restart
 * policy has real backoff and makes the outage visible.
 */
export const CRASH_LOOP_MAX_DEATHS = 3;
export const CRASH_LOOP_WINDOW_MS = 30_000;

/** Messages sent from the main thread to a protocol worker. */
export type ToProtocolWorker =
  | { t: "indexer_port"; port: MessagePort }
  | { t: "open"; id: number; ip?: string; ua?: string }
  | { t: "msgs"; msgs: Array<[id: number, data: string]> }
  | { t: "close"; id: number }
  /** Serialized NostrEvent JSON strings, parsed by the receiving worker. */
  | { t: "bcast"; events: string[] }
  | { t: "metrics"; reqId: number };

/** Messages sent from a protocol worker to the main thread. */
export type FromProtocolWorker =
  | { t: "ready"; relayInfo: NostrRelayInfo }
  | { t: "frames"; frames: Array<[id: number, frame: string]> }
  /**
   * Serialized NostrEvent JSON strings (stringified by the origin worker),
   * with each event's kind in the parallel `kinds` array so main can route
   * by kind without parsing. Parallel arrays rather than an array of pairs:
   * one fewer object per accepted event on the busiest path there is.
   */
  | { t: "accepted"; events: string[]; kinds: number[] }
  /**
   * The kinds this worker currently has live subscriptions for. Replaces
   * the previous summary wholesale. `catchAll` means at least one filter
   * omits `kinds` entirely, so the worker must receive every event.
   */
  | { t: "interest"; kinds: number[]; catchAll: boolean }
  | { t: "metrics"; reqId: number; text: string };

/** Dirty-reference batch drained from a worker's storage layer. */
export interface DirtyBatch {
  ids: string[];
  pubkeys: string[];
  addrs: string[];
  identifiers: string[];
}

/** Resolve the worker count: explicit N, or auto from core count. */
export function resolveProtocolWorkers(configured: number | undefined): number {
  if (configured !== undefined) return configured;
  const cores = navigator.hardwareConcurrency;
  return Math.max(1, Math.min(16, Math.floor(cores / 4)));
}

export class ProtocolPool {
  private workers: Worker[];
  /** Resolves with the worker's relayInfo once it posts "ready". */
  private workerReady: Promise<NostrRelayInfo>[];
  /** The single indexer worker owning all OpenSearch writes. */
  private indexer!: Worker;
  /** Resolves once the indexer posts "ready". */
  private indexerReady!: Promise<void>;
  /** Set once dispose() runs, so "close" events stop triggering respawns. */
  private disposed = false;
  /** Timestamps of recent worker deaths, for crash-loop detection. */
  private deathTimes: number[] = [];
  /** connId → index of the owning worker. */
  private connWorker = new Map<number, number>();
  /** Open-connection count per worker, for least-loaded assignment. */
  private connCounts: number[];
  /** Per-worker inbound message batches awaiting flush. */
  private queues: Array<Array<[id: number, data: string]>>;
  private flushScheduled = false;
  /**
   * Kinds each worker has live subscriptions for, used to skip fan-out to
   * workers that could not possibly match. Starts as catchAll so a worker
   * that has not reported yet receives everything — missing a broadcast is
   * a correctness bug, sending a redundant one is only waste.
   */
  private workerInterest: Array<{ kinds: Set<number>; catchAll: boolean }>;

  /** Pending /metrics round trips, keyed by request id. */
  private metricsPending = new Map<
    number,
    { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextMetricsReq = 0;

  private readonly log: Logger;
  private readonly sendFrame: (connId: number, frame: string) => void;
  private readonly onDirty?: (dirty: DirtyBatch) => void;
  private readonly onConnectionsLost?: (connIds: number[]) => void;
  private readonly onCrashLoop: () => void;
  private readonly workerEnv?: Record<string, string>;

  constructor(
    size: number,
    opts: {
      /** Deliver one finished frame to a socket. Unknown ids must be ignored. */
      sendFrame: (connId: number, frame: string) => void;
      /** Receives dirty-reference batches for the background stats worker. */
      onDirty?: (dirty: DirtyBatch) => void;
      /**
       * Called when a protocol worker dies: these connections' protocol
       * state is gone, so the server should close their sockets and let
       * clients reconnect (onto the respawned worker).
       */
      onConnectionsLost?: (connIds: number[]) => void;
      /**
       * Called when the crash-loop threshold is hit (tests override this).
       * Default: log has already fired; exit so the supervisor restarts
       * the whole process with proper backoff.
       */
      onCrashLoop?: () => void;
      logger?: Logger;
      /**
       * Environment for the worker threads (tests use this to point workers
       * at a mock OpenSearch). Bun workers snapshot the process environment
       * at process start, so runtime `process.env` mutations are NOT visible
       * to workers — production simply omits this and workers see the same
       * env (including `.env` auto-loading) as the main thread.
       */
      workerEnv?: Record<string, string>;
    },
  ) {
    this.log = opts.logger ?? new Logger();
    this.sendFrame = opts.sendFrame;
    this.onDirty = opts.onDirty;
    this.onConnectionsLost = opts.onConnectionsLost;
    this.onCrashLoop = opts.onCrashLoop ?? (() => process.exit(1));
    this.workerEnv = opts.workerEnv;

    this.connCounts = new Array(size).fill(0);
    this.queues = Array.from({ length: size }, () => []);
    this.workerInterest = Array.from({ length: size }, () => ({
      kinds: new Set<number>(),
      catchAll: true,
    }));
    this.workers = new Array(size);
    this.workerReady = new Array(size);

    // The indexer must exist before protocol workers so each spawnWorker
    // can wire its MessageChannel to it.
    this.spawnIndexer();
    for (let i = 0; i < size; i++) {
      this.spawnWorker(i);
    }
  }

  /**
   * Wire one protocol worker to the indexer with a fresh MessageChannel.
   * Both messages are posted while the workers are still evaluating their
   * modules. Nothing in the runtime holds a message until a handler exists
   * — the workers buffer for themselves from their first import (see
   * worker-inbox.ts) — so this must not be reordered to wait for "ready".
   */
  private connectIndexer(workerIndex: number): void {
    const channel = new MessageChannel();
    this.workers[workerIndex].postMessage(
      { t: "indexer_port", port: channel.port1 } satisfies ToProtocolWorker,
      [channel.port1],
    );
    this.indexer.postMessage(
      { t: "port", port: channel.port2 } satisfies ToIndexerWorker,
      [channel.port2],
    );
  }

  /** Spawn (or respawn, after a crash) the protocol worker for one slot. */
  private spawnWorker(workerIndex: number): void {
    const workerUrl = new URL("protocol-worker.ts", import.meta.url).href;
    // No `smol: true` here — unlike analyze workers, protocol workers do
    // the relay's real work and deserve a full-size heap.
    const worker = new Worker(
      workerUrl,
      this.workerEnv ? { env: this.workerEnv } : undefined,
    );
    this.workers[workerIndex] = worker;

    let markReady: (info: NostrRelayInfo) => void = () => {};
    let markFailed: (err: Error) => void = () => {};
    const ready = new Promise<NostrRelayInfo>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });
    // Mark handled so a startup failure after a respawn (when nothing is
    // awaiting this promise anymore) doesn't surface as an unhandled
    // rejection; start() and dispose() still observe the original.
    ready.catch(() => {});
    this.workerReady[workerIndex] = ready;

    worker.onmessage = (event: MessageEvent<FromProtocolWorker>) => {
      const msg = event.data;
      switch (msg.t) {
        case "ready":
          markReady(msg.relayInfo);
          break;
        case "frames":
          for (const [connId, frame] of msg.frames) {
            this.sendFrame(connId, frame);
          }
          break;
        case "accepted":
          this.fanOutAccepted(workerIndex, msg.events, msg.kinds);
          break;
        case "interest": {
          const interest = this.workerInterest[workerIndex];
          if (!interest) break;
          interest.catchAll = msg.catchAll;
          interest.kinds.clear();
          for (const kind of msg.kinds) interest.kinds.add(kind);
          break;
        }
        case "metrics": {
          const pending = this.metricsPending.get(msg.reqId);
          if (pending) {
            this.metricsPending.delete(msg.reqId);
            clearTimeout(pending.timer);
            pending.resolve(msg.text);
          }
          break;
        }
      }
    };
    worker.onerror = (error) => {
      this.log.error("protocol_worker_error", {
        worker: workerIndex,
        err_msg: error.message,
      });
      // If the worker dies during startup, fail start() instead of
      // hanging it. No-op once the ready promise has settled.
      markFailed(new Error(`protocol worker ${workerIndex} failed to start`));
    };
    // In Bun, an uncaught exception terminates the worker thread and fires
    // "close". Treat unexpected death as fatal for the worker's connections:
    // their protocol state (subscriptions, auth, negentropy) died with it,
    // so close the sockets and let clients reconnect onto the fresh worker.
    worker.addEventListener("close", () => {
      if (this.disposed || this.workers[workerIndex] !== worker) return;
      this.handleWorkerDeath(workerIndex);
    });

    this.connectIndexer(workerIndex);
  }

  /**
   * Record one worker death (protocol or indexer) in the sliding window;
   * trip the crash-loop guard when the threshold is reached. May not
   * return (default onCrashLoop exits the process).
   */
  private recordDeath(worker: string): void {
    const now = Date.now();
    this.deathTimes.push(now);
    while (this.deathTimes[0] < now - CRASH_LOOP_WINDOW_MS) {
      this.deathTimes.shift();
    }
    if (this.deathTimes.length >= CRASH_LOOP_MAX_DEATHS) {
      this.log.error("worker_crash_loop", {
        worker,
        deaths: this.deathTimes.length,
        window_ms: CRASH_LOOP_WINDOW_MS,
      });
      this.onCrashLoop();
    }
  }

  /** Recover from a protocol worker dying: drop its connections, respawn. */
  private handleWorkerDeath(workerIndex: number): void {
    this.recordDeath(String(workerIndex));
    const lost: number[] = [];
    for (const [connId, owner] of this.connWorker) {
      if (owner === workerIndex) lost.push(connId);
    }
    for (const connId of lost) {
      this.connWorker.delete(connId);
    }
    this.connCounts[workerIndex] = 0;
    this.queues[workerIndex] = [];
    // The replacement starts with no subscriptions, but reset to catchAll
    // until it says otherwise — see the field docs.
    this.workerInterest[workerIndex] = { kinds: new Set(), catchAll: true };

    this.log.error("protocol_worker_died", {
      worker: workerIndex,
      connections_lost: lost.length,
    });

    // Respawn immediately: a rare crash (poison-pill message) recovers
    // fastest this way, and new opens routed to this slot are buffered by
    // the fresh worker (worker-inbox.ts) until it's ready. Persistent
    // failures are handled by the crash-loop guard in recordDeath, not by
    // backoff here.
    this.spawnWorker(workerIndex);

    if (lost.length > 0) {
      this.onConnectionsLost?.(lost);
    }
  }

  /** Spawn (or respawn, after a crash) the indexer worker. */
  private spawnIndexer(): void {
    const indexerUrl = new URL("indexer-worker.ts", import.meta.url).href;
    const indexer = new Worker(
      indexerUrl,
      this.workerEnv ? { env: this.workerEnv } : undefined,
    );
    this.indexer = indexer;

    let markReady = () => {};
    let markFailed: (err: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });
    ready.catch(() => {});
    this.indexerReady = ready;

    indexer.onmessage = (event: MessageEvent<FromIndexerWorker>) => {
      const msg = event.data;
      switch (msg.t) {
        case "ready":
          markReady();
          break;
        case "dirty":
          this.onDirty?.(msg);
          break;
        case "metrics": {
          const pending = this.metricsPending.get(msg.reqId);
          if (pending) {
            this.metricsPending.delete(msg.reqId);
            clearTimeout(pending.timer);
            pending.resolve(msg.text);
          }
          break;
        }
      }
    };
    indexer.onerror = (error) => {
      this.log.error("indexer_worker_error", { err_msg: error.message });
      markFailed(new Error("indexer worker failed to start"));
    };
    indexer.addEventListener("close", () => {
      if (this.disposed || this.indexer !== indexer) return;
      this.log.error("indexer_worker_died", {});
      this.recordDeath("indexer");
      // Respawn and re-wire every protocol worker with a fresh port. Each
      // IndexerClient rejects its outstanding writes on rebind (they were
      // lost with the old indexer), which surfaces as OK false to clients.
      this.spawnIndexer();
      for (let i = 0; i < this.workers.length; i++) {
        this.connectIndexer(i);
      }
    });
  }

  /**
   * Wait for every worker (protocol + indexer) to finish initializing.
   * Returns the relay info document (identical across workers — same
   * config) for NIP-11 serving.
   */
  async start(): Promise<NostrRelayInfo> {
    const [infos] = await Promise.all([
      Promise.all(this.workerReady),
      this.indexerReady,
    ]);
    return infos[0];
  }

  /** Assign a new connection to the least-loaded worker. */
  open(connId: number, ip?: string, userAgent?: string): void {
    let best = 0;
    for (let i = 1; i < this.connCounts.length; i++) {
      if (this.connCounts[i] < this.connCounts[best]) best = i;
    }
    this.connWorker.set(connId, best);
    this.connCounts[best]++;
    this.workers[best].postMessage({
      t: "open",
      id: connId,
      ip,
      ua: userAgent,
    } satisfies ToProtocolWorker);
  }

  /** Forward one raw inbound message to the connection's owning worker. */
  message(connId: number, data: string): void {
    const workerIndex = this.connWorker.get(connId);
    if (workerIndex === undefined) return;
    this.queues[workerIndex].push([connId, data]);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  /** Notify the owning worker that a connection closed. */
  close(connId: number): void {
    const workerIndex = this.connWorker.get(connId);
    if (workerIndex === undefined) return;
    this.connWorker.delete(connId);
    this.connCounts[workerIndex]--;
    // Flush queued messages first so the close doesn't overtake them on the
    // worker's FIFO channel and orphan still-queued messages for this conn.
    this.flush();
    this.workers[workerIndex].postMessage({
      t: "close",
      id: connId,
    } satisfies ToProtocolWorker);
  }

  /**
   * Fan accepted events out to the other workers for broadcast matching.
   *
   * Only workers with a live subscription for an event's kind (or a
   * catch-all filter) receive it. The cost of a broadcast is paid by the
   * *receiving* worker — a JSON.parse into a full event object with its
   * tags — so a worker that cannot match the kind was previously doing
   * that work only to discard the result. With N workers every accepted
   * event cost N-1 parses regardless of interest; now it costs one per
   * genuinely interested worker.
   *
   * Main never parses: kinds ride alongside the strings from the origin
   * worker, which had the event in hand already.
   */
  private fanOutAccepted(
    originIndex: number,
    events: string[],
    kinds: number[],
  ): void {
    for (let i = 0; i < this.workers.length; i++) {
      if (i === originIndex) continue;
      const interest = this.workerInterest[i];

      let subset: string[];
      if (interest.catchAll) {
        subset = events;
      } else {
        subset = [];
        for (let j = 0; j < events.length; j++) {
          if (interest.kinds.has(kinds[j])) subset.push(events[j]);
        }
        if (subset.length === 0) continue; // nothing this worker can match
      }

      this.workers[i].postMessage({
        t: "bcast",
        events: subset,
      } satisfies ToProtocolWorker);
    }
  }

  /**
   * Inject events from outside the pool (bg stats worker) into every worker,
   * as serialized NostrEvent JSON. The bg worker pre-stringifies, so this is
   * a verbatim forward — no serialization on the main thread.
   *
   * Not interest-filtered: these arrive without kinds attached, and the
   * volume (NIP-85 stats, trend labels) is negligible next to the ingest
   * path.
   */
  broadcastExternal(events: string[]): void {
    for (const worker of this.workers) {
      worker.postMessage({ t: "bcast", events } satisfies ToProtocolWorker);
    }
  }

  /** Post all queued inbound message batches to their workers. */
  private flush(): void {
    this.flushScheduled = false;
    for (let i = 0; i < this.queues.length; i++) {
      const queue = this.queues[i];
      if (queue.length > 0) {
        this.workers[i].postMessage({
          t: "msgs",
          msgs: queue,
        } satisfies ToProtocolWorker);
        this.queues[i] = [];
      }
    }
  }

  /**
   * Collect each thread's Prometheus exposition text (protocol workers and
   * the indexer). Workers that don't answer within `timeoutMs` are skipped
   * (a wedged worker must not be able to hang the /metrics endpoint).
   */
  metrics(timeoutMs = 2_000): Promise<Array<{ label: string; text: string }>> {
    const request = (
      worker: Worker,
      label: string,
    ): Promise<{ label: string; text: string } | null> => {
      const reqId = this.nextMetricsReq++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.metricsPending.delete(reqId);
          this.log.warn("worker_metrics_timeout", { worker: label });
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        this.metricsPending.set(reqId, {
          resolve: (text) => resolve({ label, text }),
          timer,
        });
        worker.postMessage({ t: "metrics", reqId });
      });
    };

    const collected = this.workers.map((worker, i) =>
      request(worker, String(i)),
    );
    collected.push(request(this.indexer, "indexer"));

    return Promise.all(collected).then((results) =>
      results.filter((r): r is { label: string; text: string } => r !== null),
    );
  }

  /**
   * Terminate all workers. Waits for initialization to complete first —
   * terminating a worker mid-module-evaluation can segfault Bun.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const workers = this.workers;
    const ready = this.workerReady;
    const indexer = this.indexer;
    const indexerReady = this.indexerReady;
    this.workers = [];
    this.workerReady = [];
    for (const pending of this.metricsPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve("");
    }
    this.metricsPending.clear();
    try {
      await Promise.all([Promise.all(ready), indexerReady]);
    } catch (err) {
      this.log.warn("protocol_pool_ready_failed", errFields(err));
    }
    // Protocol workers first (they stop producing writes), then the indexer.
    await Promise.all(workers.map((worker) => worker.terminate()));
    await indexer.terminate();
  }
}
