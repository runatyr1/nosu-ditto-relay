import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Filter, NostrEvent } from "nostr-tools";
import { matchFilter } from "nostr-tools";
import { AdmissionError, CapacityError, DEFAULT_LIMITS, delay, Regulator, splitWindow, SyncSocket, queueBytes,
  type SyncCounters, type SyncLimits, type Window } from "./sync-protocol.ts";

export interface SyncConfig extends SyncLimits { localRelay: string; peers: string[]; historySeconds: number }
export function parseSyncConfig(value: unknown): SyncConfig {
  if (!value || typeof value !== "object") throw new Error("sync config must be an object");
  const input = value as Record<string, unknown>;
  const config = { ...DEFAULT_LIMITS, historySeconds: 3600, ...input } as SyncConfig;
  if (!Array.isArray(config.peers) || config.peers.length !== 1) throw new Error("exactly one peer is supported per daemon");
  for (const url of [config.localRelay, ...config.peers]) {
    if (typeof url !== "string" || !["ws:", "wss:"].includes(new URL(url).protocol)) throw new Error("relay URLs must use ws/wss");
  }
  for (const key of [...Object.keys(DEFAULT_LIMITS), "historySeconds"] as (keyof SyncConfig)[]) {
    if (!Number.isSafeInteger(config[key]) || Number(config[key]) < 1) throw new Error(`invalid sync limit ${key}`);
  }
  if (config.batchSize > 100 || config.batchSize > config.maxQueue || config.maxItems > 1000000) throw new Error("sync limits exceed supported bounds");
  return config;
}
type PublicJob = Window & { kind: "catchup" | "backfill" };
interface State { version: 1; coverage: Window[]; pending: PublicJob[]; backfillCompleted?: Window[]; outgoing: NostrEvent[]; privateOutgoing?: { pubkey: string; event: NostrEvent }[] }
export interface ItemStore { queryItems(filter: Filter, options: { maxItems: number; signal: AbortSignal; includeAuthKinds?: boolean }): Promise<{ created_at: number; id: string }[]> }
/** Merge only proven complete windows. Empty intervals still count as coverage. */
export function mergeCoverage(windows: Window[]): Window[] {
  const result: Window[] = [];
  for (const window of [...windows].sort((a, b) => a.since - b.since)) {
    const last = result.at(-1);
    if (last && window.since <= last.until + 1) last.until = Math.max(last.until, window.until);
    else result.push({ ...window });
  }
  return result;
}
export class SyncEngine {
  readonly counters: SyncCounters = { requests: 0, downloaded: 0, uploaded: 0, rejected: 0, retries: 0, bytes: 0, policySkipped: 0, missingAtTransfer: 0 };
  readonly requestGate: Regulator; readonly uploadGate: Regulator;
  readonly local: SyncSocket; readonly peer: SyncSocket; readonly livePeer: SyncSocket;
  state: State = { version: 1, coverage: [], pending: [], backfillCompleted: [], outgoing: [] };
  paused = false; phase = "starting"; lastError: string | null = null; lastActivity: string | null = null;
  activeWindow: PublicJob | null = null;
  private transfers = new Set<{ total: number; remaining: number }>();
  private stopped = false; private incoming: NostrEvent[] = []; private imported = new Set<string>();
  private sample = { at: Date.now(), requests: 0, events: 0, bytes: 0 };
  private rates = { requestsPerSecond: 0, eventsPerSecond: 0, bytesPerSecond: 0 };
  private writing = Promise.resolve(); private retryDelay = 1000;
  private liveError: string | null = null;
  readonly liveMetrics = { received: 0, accepted: 0, rejected: 0, overflows: 0, recoveredAt: null as string | null };
  readonly jobMetrics = {
    catchup: { accepted: 0, rejected: 0, unavailable: 0, reconciliations: 0, queries: 0, receivedBytes: 0, lastError: null as string | null },
    backfill: { accepted: 0, rejected: 0, unavailable: 0, reconciliations: 0, queries: 0, receivedBytes: 0, lastError: null as string | null },
  };
  private channelSample = { at: Date.now(), liveReceived: 0, liveEvents: 0, catchupEvents: 0, backfillEvents: 0, liveBytes: 0, peerBytes: 0 };
  private channelRates = { liveReceived: 0, liveEvents: 0, catchupEvents: 0, backfillEvents: 0, liveBytes: 0, peerBytes: 0 };
  constructor(readonly config: SyncConfig, readonly store: ItemStore, readonly stateDir: string, readonly localSignerPubkey?: string) {
    this.requestGate = new Regulator(config.requestIntervalMs); this.uploadGate = new Regulator(config.uploadIntervalMs);
    this.local = new SyncSocket(config.localRelay, config, new Regulator(0), new Regulator(0), this.counters);
    this.peer = this.socket(config.peers[0]);
    this.livePeer = this.socket(config.peers[0]);
    this.livePeer.onFailure = error => this.failLive(error);
    this.livePeer.onEvent = (event, sub) => {
      if (sub !== "live-peer" || this.paused) return;
      this.liveMetrics.received++;
      if (this.incoming.length >= config.maxQueue || queueBytes([...this.incoming, event]) > config.maxQueueBytes) { this.liveMetrics.overflows++; this.failLive(new CapacityError("Live queue full; draining before reconnect. Missed intervals await live catch-up.")); this.livePeer.close(); return; }
      if (!this.imported.has(event.id)) this.incoming.push(event);
    };
    this.local.onEvent = (event, sub) => {
      if (sub !== "live-local" || this.imported.has(event.id) || event.pubkey === this.localSignerPubkey) return;
      // Protected writes require the author's authenticated session. Never replay them anonymously.
      if (event.tags.some(([tag]) => tag === "-")) return;
      if (this.state.outgoing.some((queued) => queued.id === event.id)) return;
      if (this.state.outgoing.length >= config.maxQueue || queueBytes([...this.state.outgoing, event]) > config.maxQueueBytes) { this.fail(new CapacityError("outbound queue full; local publications require retry")); this.local.close(); return; }
      this.state.outgoing.push(event); void this.save();
    };
  }
  socket(url: string) { const socket = new SyncSocket(url, this.config, this.requestGate, this.uploadGate, this.counters); socket.onFailure = (error) => this.fail(error); return socket; }
  isImported(id: string) { return this.imported.has(id); }
  userOutbox(pubkey: string) { return (this.state.privateOutgoing ?? []).filter(item => item.pubkey === pubkey).map(item => item.event); }
  async queueUserPublication(pubkey: string, event: NostrEvent) {
    const outbox = this.state.privateOutgoing ??= [];
    if (!outbox.some(item => item.pubkey === pubkey && item.event.id === event.id)) {
      if (outbox.length >= this.config.maxQueue || queueBytes([...outbox.map(item => item.event), event]) > this.config.maxQueueBytes) throw new CapacityError("private durable outbound queue full");
      outbox.push({ pubkey, event });
    }
    await this.save();
  }
  async acknowledgeUserPublication(pubkey: string, id: string) {
    this.state.privateOutgoing = (this.state.privateOutgoing ?? []).filter(item => item.pubkey !== pubkey || item.event.id !== id);
    await this.save();
  }
  private fail(error: Error) {
    this.lastError = error.message.slice(0, 300); this.phase = "attention";
    console.error(JSON.stringify({ level: "warn", msg: "sync_failed", reason: this.lastError }));
  }
  private failLive(error: Error) {
    this.liveError = error.message.slice(0, 300);
    console.error(JSON.stringify({ level: "warn", msg: "sync_live_failed", reason: this.liveError }));
  }
  async reconnectLive() {
    await this.livePeer.connect(); await this.livePeer.subscribe("live-peer", [{}]);
    if (this.livePeer.connected && this.liveError) {
      this.liveError = null; this.liveMetrics.recoveredAt = new Date().toISOString();
      console.log(JSON.stringify({ level: "info", msg: "sync_live_recovered" }));
    }
  }
  async load() {
    await mkdir(this.stateDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.stateDir, "sync.json"), "utf8")) as State;
      if (saved.version !== 1 || !Array.isArray(saved.coverage) || !Array.isArray(saved.pending) || !Array.isArray(saved.outgoing)) throw new Error("invalid sync state");
      if (saved.outgoing.length > this.config.maxQueue || queueBytes(saved.outgoing) > this.config.maxQueueBytes) throw new Error("persisted queue exceeds configured cap");
      if (saved.privateOutgoing && (!Array.isArray(saved.privateOutgoing) || saved.privateOutgoing.length > this.config.maxQueue || queueBytes(saved.privateOutgoing.map(item => item.event)) > this.config.maxQueueBytes)) throw new Error("persisted private queue exceeds configured cap");
      for (const window of [...saved.coverage, ...saved.pending]) if (!Number.isSafeInteger(window.since) || !Number.isSafeInteger(window.until) || window.since < 0 || window.since > window.until) throw new Error("invalid saved coverage");
      // v1 windows predate job labels. Windows older than completed coverage
      // were explicit backfills; forward gaps and the initial hour are catch-up.
      const oldest = saved.coverage[0]?.since;
      saved.pending = saved.pending.map(job => ({ ...job, kind: job.kind === "backfill" || (job.kind !== "catchup" && oldest !== undefined && job.until < oldest) ? "backfill" : "catchup" }));
      saved.backfillCompleted ??= [];
      if (!Array.isArray(saved.backfillCompleted)) throw new Error("invalid saved backfill coverage");
      for (const window of saved.backfillCompleted) if (!Number.isSafeInteger(window.since) || !Number.isSafeInteger(window.until) || window.since < 0 || window.since > window.until) throw new Error("invalid saved backfill coverage");
      this.state = saved;
      // Relay-generated statistics remain local. Only client publications are
      // exported, including after loading an older persisted public queue.
      this.state.outgoing = this.state.outgoing.filter(event => event.pubkey !== this.localSignerPubkey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const until = Math.floor(Date.now() / 1000);
      this.state.pending.push({ kind: "catchup", since: until - this.config.historySeconds + 1, until }); await this.save();
    }
  }
  save() {
    const snapshot = JSON.stringify(this.state);
    this.writing = this.writing.then(async () => {
      const path = join(this.stateDir, "sync.json");
      await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 }); await rename(`${path}.tmp`, path);
    });
    return this.writing;
  }
  async control(action: string) {
    if (action === "pause") { this.paused = true; this.phase = "paused"; this.peer.close(); this.livePeer.close(); this.local.close(); }
    else if (action === "resume" || action === "retry") {
      this.paused = false; this.lastError = null; this.retryDelay = 1000;
      this.jobMetrics.catchup.lastError = null; this.jobMetrics.backfill.lastError = null;
    }
    else if (action === "backfill") {
      if (!this.state.coverage.length || this.state.pending.length || this.activeWindow) throw new Error("finish current coverage before extending history");
      const oldest = Math.min(...this.state.coverage.map((window) => window.since));
      if (oldest === 0) throw new Error("history already reaches timestamp zero");
      this.state.pending.push({ kind: "backfill", since: Math.max(0, oldest - this.config.historySeconds), until: oldest - 1 }); await this.save();
    } else throw new Error("unknown sync action");
  }
  async importEvent(event: NostrEvent, destination = this.local) {
    this.imported.add(event.id);
    // Bound duplicate memory; last-hour reconciliation repairs disconnected gaps.
    if (this.imported.size > this.config.maxItems) this.imported.delete(this.imported.values().next().value!);
    try {
      await destination.publish(event);
      if (destination.url === this.config.peers[0]) this.counters.uploaded++;
      else this.counters.downloaded++;
      this.lastActivity = new Date().toISOString();
    }
    catch (error) { this.counters.rejected++; throw error; }
  }
  async transferWindow(window: Window, filter: Filter = {}, source = this.peer, destination = this.local, authenticated = false, cancelled = () => false, publicKind?: PublicJob["kind"]) {
    const metrics = publicKind ? this.jobMetrics[publicKind] : undefined;
    const scoped = { ...filter, ...window };
    const items = await this.store.queryItems(scoped, { maxItems: this.config.maxItems, signal: AbortSignal.timeout(60000), includeAuthKinds: authenticated });
    if (metrics) metrics.reconciliations++;
    const { need: ids } = await source.reconcile(scoped, items);
    const transfer = { total: ids.length, remaining: ids.length }; this.transfers.add(transfer);
    try {
    for (let offset = 0; offset < ids.length; offset += this.config.batchSize) {
      while (this.paused && !this.stopped && !cancelled()) await delay(250);
      if (this.stopped || cancelled()) throw new Error("sync stopped or revoked");
      const batch = ids.slice(offset, offset + this.config.batchSize);
      if (metrics) metrics.queries++;
      const events = await source.query({ ...scoped, ids: batch, limit: batch.length });
      const returned = new Set(events.map((event) => event.id));
      const missing = batch.filter((id) => !returned.has(id));
      // Deletion/expiration can race reconciliation. Retry once before reporting
      // unavailable IDs explicitly; never discard a failed request as complete.
      if (missing.length) {
        if (metrics) metrics.queries++;
        const retried = await source.query({ ...scoped, ids: missing, limit: missing.length });
        for (const event of retried) if (!returned.has(event.id)) { returned.add(event.id); events.push(event); }
        const unavailable = batch.filter((id) => !returned.has(id)).length;
        this.counters.missingAtTransfer += unavailable;
        if (metrics) metrics.unavailable += unavailable;
      }
      const imports = await Promise.allSettled(events.map(async (event) => {
        if (cancelled()) throw new Error("user synchronization revoked");
        if (!batch.includes(event.id) || !matchFilter(scoped, event)) throw new Error("peer returned event outside reconciliation scope");
        try { await this.importEvent(event, destination); if (metrics) metrics.accepted++; }
        catch (error) {
          if (metrics) metrics.rejected++;
          if (!(error instanceof AdmissionError)) throw error;
          // Admission remains authoritative. Coverage means examined, with
          // rejected/protected events reported as exclusions, never stored by bypass.
          this.counters.policySkipped++;
        }
      }));
      const failed = imports.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      transfer.remaining -= batch.length;
    }
    } finally { this.transfers.delete(transfer); }
  }
  async fullUserHistory(filters: Filter[], source: SyncSocket, destination: SyncSocket, until: number, cancelled = () => false) {
    // Each user's scope has independent resumable-in-memory windows, never a public timestamp cap.
    for (const filter of filters) {
      const pending: Window[] = [{ since: 0, until }];
      while (pending.length) {
        const window = pending.shift()!;
        if (cancelled()) throw new Error("user synchronization revoked");
        try {
          await this.transferWindow(window, filter, source, destination, true, cancelled);
          const scoped = { ...filter, ...window };
          const items = await this.store.queryItems(scoped, { maxItems: this.config.maxItems, signal: AbortSignal.timeout(60000), includeAuthKinds: true });
          const { have } = await source.reconcile(scoped, items);
          for (let offset = 0; offset < have.length; offset += this.config.batchSize) {
            while (this.paused && !this.stopped && !cancelled()) await delay(250);
            if (cancelled() || this.stopped) throw new Error("user synchronization revoked or stopped");
            const events = await destination.query({ ...scoped, ids: have.slice(offset, offset + this.config.batchSize), limit: this.config.batchSize });
            for (const event of events) {
              try { await this.importEvent(event, source); }
              catch (error) { if (!(error instanceof AdmissionError)) throw error; this.counters.policySkipped++; }
            }
          }
        }
        catch (error) {
          if (error instanceof CapacityError) pending.unshift(...splitWindow(window)); else throw error;
        }
      }
    }
  }
  private async connect() {
    await Promise.all([this.local.connect(), this.peer.connect()]);
    await this.local.subscribe("live-local", [{}]);
    const latest = this.state.coverage.at(-1)?.until;
    const now = Math.floor(Date.now() / 1000);
    if (!this.state.pending.length && latest !== undefined && now > latest) this.state.pending.push({ kind: "catchup", since: latest + 1, until: now });
    this.phase = "live";
  }
  async run() {
    await this.load();
    void this.drainLive();
    void this.drainUploads();
    void this.maintainLive();
    while (!this.stopped) {
      if (this.paused) { await delay(250); continue; }
      try {
        if (!this.local.connected || !this.peer.connected) await this.connect();
        if (this.state.pending.length) {
          const window = this.state.pending[0]; this.activeWindow = window; this.phase = window.kind;
          try {
            await this.transferWindow(window, {}, this.peer, this.local, false, () => false, window.kind);
            this.state.pending.shift(); this.state.coverage = mergeCoverage([...this.state.coverage, window]);
            if (window.kind === "backfill") this.state.backfillCompleted = mergeCoverage([...(this.state.backfillCompleted ?? []), window]);
            await this.save(); this.lastError = null; this.jobMetrics[window.kind].lastError = null;
          } catch (error) {
            if (error instanceof CapacityError) { this.state.pending.splice(0, 1, ...splitWindow(window).map(part => ({ ...part, kind: window.kind }))); await this.save(); }
            else throw error;
          } finally { this.activeWindow = null; }
        } else {
          const latest = this.state.coverage.at(-1)?.until, now = Math.floor(Date.now() / 1000);
          // Also repair gaps accumulated while the initial catch-up was still
          // pending; a reconnect alone cannot checkpoint those later intervals.
          if (latest !== undefined && now - latest >= 60) {
            this.state.pending.push({ kind: "catchup", since: latest + 1, until: now }); await this.save();
          } else { this.phase = this.lastError ? "attention" : "live"; await delay(250); }
        }
        this.retryDelay = 1000;
      } catch (error) {
        if (!this.paused) {
          const kind = this.activeWindow?.kind ?? this.state.pending[0]?.kind;
          if (kind) this.jobMetrics[kind].lastError = (error as Error).message.slice(0, 300);
          this.fail(error as Error); this.counters.retries++; this.peer.close();
          await delay(this.retryDelay + Math.random() * this.retryDelay / 2);
          this.retryDelay = Math.min(60000, this.retryDelay * 2);
        }
      }
    }
  }
  private async maintainLive() {
    let retry = 1000;
    while (!this.stopped) {
      if (this.paused || !this.local.connected || this.livePeer.connected || this.incoming.length > this.config.maxQueue / 2) { await delay(250); continue; }
      try {
        await this.reconnectLive(); retry = 1000;
      } catch (error) {
        if (!this.paused) { this.failLive(error as Error); this.counters.retries++; }
        this.livePeer.close(); await delay(retry + Math.random() * retry / 2); retry = Math.min(60000, retry * 2);
      }
    }
  }
  private async drainUploads() {
    while (!this.stopped) {
      if (this.paused || !this.peer.connected || !this.state.outgoing.length) { await delay(100); continue; }
      const event = this.state.outgoing[0];
      try { await this.peer.publish(event); this.counters.uploaded++; this.state.outgoing.shift(); await this.save(); }
      catch (error) {
        this.fail(error as Error);
        if (error instanceof AdmissionError) { this.counters.rejected++; this.state.outgoing.shift(); await this.save(); }
        else { this.counters.retries++; await delay(5000); }
      }
    }
  }
  private async drainLive() {
    const active = new Set<string>();
    while (!this.stopped) {
      if (this.paused || !this.local.connected || !this.incoming.length) { await delay(100); continue; }
      // A slow media-analysis/storage acknowledgement must not hold every
      // other live event behind a batch barrier. Keep only 25 local imports active.
      for (const event of this.incoming) {
        if (active.size >= this.config.batchSize) break;
        if (active.has(event.id)) continue;
        active.add(event.id);
        void this.importEvent(event).then(() => {
          this.liveMetrics.accepted++;
          this.incoming = this.incoming.filter(item => item.id !== event.id);
        }, error => {
          this.liveMetrics.rejected++;
          if (error instanceof AdmissionError) { this.counters.policySkipped++; this.incoming = this.incoming.filter(item => item.id !== event.id); }
          else this.fail(error);
        }).finally(() => active.delete(event.id));
      }
      await delay(100);
    }
  }
  status() {
    const channelElapsed = (Date.now() - this.channelSample.at) / 1000;
    if (channelElapsed >= 1) {
      this.channelRates = {
        liveReceived: (this.liveMetrics.received - this.channelSample.liveReceived) / channelElapsed,
        liveEvents: (this.liveMetrics.accepted - this.channelSample.liveEvents) / channelElapsed,
        catchupEvents: (this.jobMetrics.catchup.accepted - this.channelSample.catchupEvents) / channelElapsed,
        backfillEvents: (this.jobMetrics.backfill.accepted - this.channelSample.backfillEvents) / channelElapsed,
        liveBytes: (this.livePeer.traffic.receivedBytes - this.channelSample.liveBytes) / channelElapsed,
        peerBytes: (this.peer.traffic.receivedBytes - this.channelSample.peerBytes) / channelElapsed,
      };
      this.channelSample = { at: Date.now(), liveReceived: this.liveMetrics.received, liveEvents: this.liveMetrics.accepted,
        catchupEvents: this.jobMetrics.catchup.accepted, backfillEvents: this.jobMetrics.backfill.accepted,
        liveBytes: this.livePeer.traffic.receivedBytes, peerBytes: this.peer.traffic.receivedBytes };
    }
    const elapsed = (Date.now() - this.sample.at) / 1000;
    if (elapsed >= 1) {
      this.rates = { requestsPerSecond: (this.counters.requests - this.sample.requests) / elapsed,
        eventsPerSecond: (this.counters.downloaded + this.counters.uploaded - this.sample.events) / elapsed,
        bytesPerSecond: (this.counters.bytes - this.sample.bytes) / elapsed };
      this.sample = { at: Date.now(), requests: this.counters.requests, events: this.counters.downloaded + this.counters.uploaded, bytes: this.counters.bytes };
    }
    const currentError = this.lastError ?? this.liveError;
    const jobStatus = (kind: PublicJob["kind"]) => {
      const active = this.activeWindow?.kind === kind ? this.activeWindow : null;
      const metrics = this.jobMetrics[kind];
      return { ...metrics, state: this.paused ? "paused" : active ? metrics.lastError ? "retrying" : "running" : metrics.lastError ? "needs attention" : this.state.pending.some(job => job.kind === kind) ? "pending" : "idle",
        activeWindow: active, pendingWindows: this.state.pending.filter(job => job.kind === kind).length,
        identified: active ? [...this.transfers].reduce((n, job) => n + job.total, 0) : 0,
        remaining: active ? [...this.transfers].reduce((n, job) => n + job.remaining, 0) : 0,
        pendingRequests: active ? this.peer.pendingRequests : 0,
        eventsPerSecond: this.channelRates[kind === "catchup" ? "catchupEvents" : "backfillEvents"],
      };
    };
    return { paused: this.paused, phase: this.paused ? "paused" : currentError ? "attention" : this.activeWindow ? this.activeWindow.kind : this.phase, localRelay: this.config.localRelay, peer: this.config.peers[0],
      live: { ...this.liveMetrics, error: this.liveError, state: this.paused ? "paused" : this.livePeer.connected ? "live" : this.liveError ? "draining / reconnecting" : "connecting",
        queue: this.incoming.length, queueBytes: queueBytes(this.incoming), receivedBytes: this.livePeer.traffic.receivedBytes,
        subscriptions: this.livePeer.traffic.subscriptions, receivedEventsPerSecond: this.channelRates.liveReceived, eventsPerSecond: this.channelRates.liveEvents, bytesPerSecond: this.channelRates.liveBytes },
      catchup: { ...jobStatus("catchup"), latestCovered: this.state.coverage.at(-1)?.until ?? null },
      backfill: { ...jobStatus("backfill"), completedWindows: this.state.backfillCompleted ?? [] },
      connected: { local: this.local.connected, peer: this.peer.connected, live: this.livePeer.connected },
      coverage: { oldest: this.state.coverage[0]?.since ?? null, latest: this.state.coverage.at(-1)?.until ?? null, windows: this.state.coverage },
      queues: { downloads: this.incoming.length, uploads: this.state.outgoing.length }, rates: this.rates,
      queueBytes: { downloads: queueBytes(this.incoming), uploads: queueBytes(this.state.outgoing) },
      pendingRequests: this.peer.pendingRequests + this.local.pendingRequests,
      pendingAcks: this.peer.pendingAcks + this.local.pendingAcks,
      coverageMeaning: "Catch-up covers the initial hour and later gaps; backfill covers only requested older windows. Policy-skipped and unavailable events are counted separately",
      counters: this.counters, lastError: currentError, lastActivity: this.lastActivity, limits: this.config };
  }
  stop() { this.stopped = true; this.local.close(); this.peer.close(); this.livePeer.close(); }
}
