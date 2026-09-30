import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Filter, NostrEvent } from "nostr-tools";
import { matchFilter } from "nostr-tools";
import serviceConfig from "../service-config.json";
import { AdmissionError, CapacityError, DEFAULT_LIMITS, delay, Regulator, splitWindow, SyncSocket, queueBytes,
  type SyncCounters, type SyncLimits, type Window } from "./sync-protocol.ts";

export interface SyncConfig extends SyncLimits { localRelay: string; peers: string[]; livePeers: string[]; historySeconds: number; priorityProbeIntervalMs: number }
export function parseSyncConfig(value: unknown): SyncConfig {
  if (!value || typeof value !== "object") throw new Error("sync config must be an object");
  const input = value as Record<string, unknown>;
  const peers = input.peers === undefined ? serviceConfig.relays.catchupAndBackfill : input.peers;
  const livePeers = input.livePeers === undefined
    ? input.peers === undefined ? serviceConfig.relays.live : Array.isArray(peers) ? [peers[0]] : peers
    : input.livePeers;
  const config = { ...DEFAULT_LIMITS, historySeconds: 3600, priorityProbeIntervalMs: 60000, ...input, peers, livePeers } as SyncConfig;
  if (!Array.isArray(config.peers) || !config.peers.length || config.peers.length > 4 || new Set(config.peers).size !== config.peers.length) throw new Error("configure one to four distinct peers");
  if (!Array.isArray(config.livePeers) || !config.livePeers.length || config.livePeers.length > 4 || new Set(config.livePeers).size !== config.livePeers.length || config.livePeers[0] !== config.peers[0]) throw new Error("configure one to four distinct live peers with the same primary");
  for (const url of [config.localRelay, ...config.peers, ...config.livePeers]) {
    if (typeof url !== "string" || !["ws:", "wss:"].includes(new URL(url).protocol)) throw new Error("relay URLs must use ws/wss");
  }
  for (const key of [...Object.keys(DEFAULT_LIMITS), "historySeconds", "priorityProbeIntervalMs"] as (keyof SyncConfig)[]) {
    if (!Number.isSafeInteger(config[key]) || Number(config[key]) < 1) throw new Error(`invalid sync limit ${key}`);
  }
  if (config.batchSize > 100 || config.batchSize > config.maxQueue || config.maxItems > 1000000 || config.priorityProbeIntervalMs < 60000 || config.priorityProbeIntervalMs > 86400000) throw new Error("sync limits exceed supported bounds");
  return config;
}
type PublicJob = Window & { kind: "catchup" | "backfill" };
const LIVE_IDLE_PROBE_MS = 90000;
interface State { version: 1; coverage: Window[]; pending: PublicJob[]; backfillCompleted?: Window[]; outgoing: NostrEvent[]; privateOutgoing?: { pubkey: string; event: NostrEvent }[]; activePublicPeer?: string; activeLivePeer?: string; lastCoveragePeer?: string }
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
  readonly local: SyncSocket; peer: SyncSocket; livePeer: SyncSocket; readonly uploadPeer: SyncSocket;
  state: State = { version: 1, coverage: [], pending: [], backfillCompleted: [], outgoing: [] };
  paused = false; phase = "starting"; lastError: string | null = null; lastActivity: string | null = null;
  activeWindow: PublicJob | null = null;
  private transfers = new Set<{ total: number; remaining: number }>();
  private stopped = false; private incoming: NostrEvent[] = []; private imported = new Set<string>();
  private sample = { at: Date.now(), requests: 0, events: 0, bytes: 0 };
  private rates = { requestsPerSecond: 0, eventsPerSecond: 0, bytesPerSecond: 0 };
  private writing = Promise.resolve(); private retryDelay = 1000; private peerIndex = 0; private livePeerIndex = 0;
  private lastPublicPriorityProbeAt = 0; private lastLivePriorityProbeAt = 0;
  private publicProbeCursor = 0; private liveProbeCursor = 0;
  private liveFailoverPending = false; private liveQueueDraining = false;
  private liveError: string | null = null;
  private lastLiveEventAt = Date.now(); private lastLiveProbeAt = 0;
  readonly liveMetrics = { received: 0, accepted: 0, rejected: 0, overflows: 0, probes: 0, staleDetections: 0,
    lastProbeAt: null as string | null, recoveredAt: null as string | null };
  readonly jobMetrics = {
    catchup: { accepted: 0, rejected: 0, unavailable: 0, reconciliations: 0, queries: 0, nip77Refusals: 0, nip77LastSuccessAt: null as string | null, nip77LastFailure: null as string | null, nip77LastFailureAt: null as string | null, nextRetryAt: null as string | null, lastError: null as string | null },
    backfill: { accepted: 0, rejected: 0, unavailable: 0, reconciliations: 0, queries: 0, nip77Refusals: 0, nip77LastSuccessAt: null as string | null, nip77LastFailure: null as string | null, nip77LastFailureAt: null as string | null, nextRetryAt: null as string | null, lastError: null as string | null },
  };
  private channelSample = { at: Date.now(), liveReceived: 0, liveEvents: 0, catchupEvents: 0, backfillEvents: 0, liveBytes: 0, peerBytes: 0 };
  private channelRates = { liveReceived: 0, liveEvents: 0, catchupEvents: 0, backfillEvents: 0, liveBytes: 0, peerBytes: 0 };
  constructor(readonly config: SyncConfig, readonly store: ItemStore, readonly stateDir: string, readonly localSignerPubkey?: string) {
    this.requestGate = new Regulator(config.requestIntervalMs); this.uploadGate = new Regulator(config.uploadIntervalMs);
    this.local = new SyncSocket(config.localRelay, config, new Regulator(0), new Regulator(0), this.counters);
    this.peer = this.socket(config.peers[0]);
    this.livePeer = this.liveSocket(config.livePeers[0]);
    this.uploadPeer = this.socket(config.peers[0]);
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
  private probeSocket(url: string) { return new SyncSocket(url, this.config, this.requestGate, this.uploadGate, this.counters); }
  private liveSocket(url: string) {
    const socket = this.probeSocket(url);
    socket.onFailure = error => { if (this.livePeer === socket) { this.failLive(error); this.liveFailoverPending = true; } };
    socket.onDisconnect = () => { if (this.livePeer === socket && !this.paused && !this.stopped && !this.liveQueueDraining) this.liveFailoverPending = true; };
    socket.onClosed = (sub, reason) => {
      if (this.livePeer !== socket) return;
      if (sub !== "live-peer") return;
      this.failLive(new Error(`Live subscription closed: ${reason}`));
      this.liveFailoverPending = true;
      socket.close();
    };
    socket.onEvent = (event, sub) => {
      if (this.livePeer !== socket || sub !== "live-peer" || this.paused) return;
      this.lastLiveEventAt = Date.now();
      this.liveMetrics.received++;
      if (this.incoming.length >= this.config.maxQueue || queueBytes([...this.incoming, event]) > this.config.maxQueueBytes) { this.liveMetrics.overflows++; this.liveQueueDraining = true; this.failLive(new CapacityError("Live queue full; draining before reconnect. Missed intervals await live catch-up.")); socket.close(); return; }
      if (!this.imported.has(event.id)) this.incoming.push(event);
    };
    return socket;
  }
  private async switchPublicPeer(index: number, reason: "failure" | "recovered") {
    if (index === this.peerIndex) return;
    this.peer.close(); this.peerIndex = index;
    this.publicProbeCursor = 0;
    this.peer = this.socket(this.config.peers[index]);
    this.channelSample.peerBytes = 0;
    this.state.activePublicPeer = this.peer.url;
    await this.save();
    console.log(JSON.stringify({ level: "info", msg: "sync_public_peer_changed", peer: this.peer.url, reason }));
  }
  private async failoverPublicPeer() {
    this.lastPublicPriorityProbeAt = Date.now();
    await this.switchPublicPeer(Math.min(this.peerIndex + 1, this.config.peers.length - 1), "failure");
  }
  /** Check one higher-priority peer per interval with a bounded NIP-77 window. */
  private async recoverPublicPeerIfDue(now = Date.now()) {
    if (this.peerIndex === 0 || this.activeWindow || now - this.lastPublicPriorityProbeAt < this.config.priorityProbeIntervalMs) return;
    this.lastPublicPriorityProbeAt = now;
    const until = Math.floor(now / 1000) - 30;
    const index = this.publicProbeCursor % this.peerIndex;
    this.publicProbeCursor = (index + 1) % this.peerIndex;
    const probe = this.probeSocket(this.config.peers[index]);
    let available = false;
    try {
      await probe.connect();
      await probe.reconcile({ since: until - 59, until }, [], 15000);
      available = true;
      console.log(JSON.stringify({ level: "info", msg: "sync_priority_probe", peer: probe.url, result: "available", channel: "catchup" }));
    } catch (error) {
      console.log(JSON.stringify({ level: "info", msg: "sync_priority_probe", peer: probe.url, result: "unavailable", channel: "catchup", reason: (error as Error).message.slice(0, 160) }));
    } finally { probe.close(); }
    if (available && !this.paused && !this.stopped) {
      await this.switchPublicPeer(index, "recovered");
    }
  }
  private async switchLivePeer(index: number, reason: "failure" | "recovered") {
    if (index === this.livePeerIndex) return;
    const old = this.livePeer;
    this.livePeerIndex = index;
    this.liveProbeCursor = 0;
    this.livePeer = this.liveSocket(this.config.livePeers[index]);
    this.channelSample.liveBytes = 0;
    old.close();
    this.state.activeLivePeer = this.livePeer.url;
    this.liveFailoverPending = false; this.liveQueueDraining = false;
    this.lastLiveEventAt = Date.now(); this.lastLiveProbeAt = 0;
    await this.save();
    console.log(JSON.stringify({ level: "info", msg: "sync_live_peer_changed", peer: this.livePeer.url, reason }));
  }
  private async failoverLivePeer() {
    this.lastLivePriorityProbeAt = Date.now();
    await this.switchLivePeer(Math.min(this.livePeerIndex + 1, this.config.livePeers.length - 1), "failure");
  }
  /** Check one higher-priority live peer per interval with a public REQ/EOSE. */
  private async recoverLivePeerIfDue(now = Date.now()) {
    if (this.livePeerIndex === 0 || now - this.lastLivePriorityProbeAt < this.config.priorityProbeIntervalMs) return;
    this.lastLivePriorityProbeAt = now;
    const index = this.liveProbeCursor % this.livePeerIndex;
    this.liveProbeCursor = (index + 1) % this.livePeerIndex;
    const probe = this.probeSocket(this.config.livePeers[index]);
    let available = false;
    try {
      await probe.connect();
      await probe.query({ since: Math.floor(now / 1000) - 90, limit: 1 }, 15000);
      available = true;
      console.log(JSON.stringify({ level: "info", msg: "sync_priority_probe", peer: probe.url, result: "available", channel: "live" }));
    } catch (error) {
      console.log(JSON.stringify({ level: "info", msg: "sync_priority_probe", peer: probe.url, result: "unavailable", channel: "live", reason: (error as Error).message.slice(0, 160) }));
    } finally { probe.close(); }
    if (available && !this.paused && !this.stopped) {
      await this.switchLivePeer(index, "recovered");
    }
  }
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
    this.lastLiveEventAt = Date.now(); this.lastLiveProbeAt = 0;
    this.liveQueueDraining = false; this.liveFailoverPending = false;
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
      if (saved.activePublicPeer && this.config.peers.includes(saved.activePublicPeer)) {
        this.peerIndex = this.config.peers.indexOf(saved.activePublicPeer);
        this.peer = this.socket(saved.activePublicPeer);
      }
      if (saved.activeLivePeer && this.config.livePeers.includes(saved.activeLivePeer)) {
        this.livePeerIndex = this.config.livePeers.indexOf(saved.activeLivePeer);
        this.livePeer = this.liveSocket(saved.activeLivePeer);
      }
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
    if (action === "pause") { this.paused = true; this.phase = "paused"; this.peer.close(); this.livePeer.close(); this.uploadPeer.close(); this.local.close(); }
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
    // Job metadata is local bookkeeping, never part of a Nostr filter.
    const scoped = { ...filter, since: window.since, until: window.until };
    const items = await this.store.queryItems(scoped, { maxItems: this.config.maxItems, signal: AbortSignal.timeout(60000), includeAuthKinds: authenticated });
    if (metrics) metrics.reconciliations++;
    let ids: string[];
    try {
      ({ need: ids } = await source.reconcile(scoped, items));
      if (metrics) { metrics.nip77LastSuccessAt = new Date().toISOString(); metrics.lastError = null; this.lastError = null; }
    } catch (error) {
      if (metrics) {
        metrics.nip77LastFailure = (error as Error).message.slice(0, 300);
        metrics.nip77LastFailureAt = new Date().toISOString();
        if (/^(blocked:|rate-limited:)/.test((error as Error).message)) metrics.nip77Refusals++;
      }
      throw error;
    }
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
        // Change peers only between windows: NIP-77 and its ID downloads
        // must use the same peer even if a recovery probe comes due.
        await this.recoverPublicPeerIfDue();
        if (!this.local.connected || !this.peer.connected) await this.connect();
        if (this.state.pending.length) {
          const window = this.state.pending[0]; this.activeWindow = window; this.phase = window.kind;
          this.jobMetrics[window.kind].nextRetryAt = null;
          try {
            await this.transferWindow(window, {}, this.peer, this.local, false, () => false, window.kind);
            this.state.pending.shift(); this.state.coverage = mergeCoverage([...this.state.coverage, window]);
            if (window.kind === "backfill") this.state.backfillCompleted = mergeCoverage([...(this.state.backfillCompleted ?? []), window]);
            this.state.lastCoveragePeer = this.peer.url;
            await this.save(); this.lastError = null; this.jobMetrics[window.kind].lastError = null; this.jobMetrics[window.kind].nextRetryAt = null;
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
          if (/^(blocked:|rate-limited:)|relay (?:connection|response)|relay (?:is )?disconnected/i.test((error as Error).message)) {
            try { await this.failoverPublicPeer(); }
            catch (switchError) { this.fail(switchError as Error); }
          }
          const waitMs = this.retryDelay + Math.random() * this.retryDelay / 2;
          if (kind) this.jobMetrics[kind].nextRetryAt = new Date(Date.now() + waitMs).toISOString();
          await delay(waitMs);
          this.retryDelay = Math.min(60000, this.retryDelay * 2);
        }
      }
    }
  }
  private async maintainLive() {
    let retry = 1000;
    while (!this.stopped) {
      if (this.paused || !this.local.connected || this.incoming.length > this.config.maxQueue / 2) { await delay(250); continue; }
      if (this.liveFailoverPending && !this.liveQueueDraining) {
        try { await this.failoverLivePeer(); retry = 1000; }
        catch (error) { this.failLive(error as Error); await delay(retry); continue; }
        this.liveFailoverPending = false;
      }
      if (this.livePeer.connected) {
        try { await this.probeLiveIfIdle(); await this.recoverLivePeerIfDue(); }
        catch (error) { this.failLive(error as Error); this.counters.retries++; this.liveFailoverPending = true; this.livePeer.close(); }
        await delay(250); continue;
      }
      try {
        await this.reconnectLive(); retry = 1000;
      } catch (error) {
        if (!this.paused) { this.failLive(error as Error); this.counters.retries++; }
        this.liveQueueDraining = false;
        this.livePeer.close();
        if (!this.paused) {
          try { await this.failoverLivePeer(); }
          catch (switchError) { this.failLive(switchError as Error); }
        }
        await delay(retry + Math.random() * retry / 2); retry = Math.min(60000, retry * 2);
      }
    }
  }
  private async probeLiveIfIdle(now = Date.now()) {
    if (now - this.lastLiveEventAt < LIVE_IDLE_PROBE_MS || now - this.lastLiveProbeAt < LIVE_IDLE_PROBE_MS) return;
    this.lastLiveProbeAt = now;
    this.liveMetrics.probes++; this.liveMetrics.lastProbeAt = new Date(now).toISOString();
    const recent = await this.livePeer.query({ since: Math.floor((now - LIVE_IDLE_PROBE_MS) / 1000), limit: 1 }, 15000);
    if (recent.length && this.lastLiveEventAt <= now) {
      this.liveMetrics.staleDetections++;
      throw new Error("Live subscription silent while peer has recent events; reconnecting");
    }
    await this.livePeer.subscribe("live-peer", [{}]);
    this.lastLiveEventAt = Date.now();
  }
  private async drainUploads() {
    while (!this.stopped) {
      if (this.paused || !this.state.outgoing.length) { await delay(100); continue; }
      const event = this.state.outgoing[0];
      try { if (!this.uploadPeer.connected) await this.uploadPeer.connect(); await this.uploadPeer.publish(event); this.counters.uploaded++; this.state.outgoing.shift(); await this.save(); }
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
    return { paused: this.paused, phase: this.paused ? "paused" : currentError ? "attention" : this.activeWindow ? this.activeWindow.kind : this.phase, localRelay: this.config.localRelay, peer: this.peer.url, lastCoveragePeer: this.state.lastCoveragePeer ?? null,
      nextPublicPriorityProbeAt: this.peerIndex ? new Date(Math.max(Date.now(), this.lastPublicPriorityProbeAt + this.config.priorityProbeIntervalMs)).toISOString() : null,
      live: { ...this.liveMetrics, error: this.liveError, state: this.paused ? "paused" : this.livePeer.connected ? "live" : this.liveError ? "draining / reconnecting" : "connecting",
        peer: this.livePeer.url, nextPriorityProbeAt: this.livePeerIndex ? new Date(Math.max(Date.now(), this.lastLivePriorityProbeAt + this.config.priorityProbeIntervalMs)).toISOString() : null,
        queue: this.incoming.length, queueBytes: queueBytes(this.incoming), receivedBytes: this.livePeer.traffic.receivedBytes,
        subscriptions: this.livePeer.traffic.subscriptions, receivedEventsPerSecond: this.channelRates.liveReceived, eventsPerSecond: this.channelRates.liveEvents, bytesPerSecond: this.channelRates.liveBytes },
      catchup: { ...jobStatus("catchup"), peer: this.peer.url, latestCovered: this.state.coverage.at(-1)?.until ?? null },
      backfill: { ...jobStatus("backfill"), peer: this.peer.url, completedWindows: this.state.backfillCompleted ?? [] },
      connected: { local: this.local.connected, peer: this.peer.connected, live: this.livePeer.connected },
      coverage: { oldest: this.state.coverage[0]?.since ?? null, latest: this.state.coverage.at(-1)?.until ?? null, windows: this.state.coverage },
      queues: { downloads: this.incoming.length, uploads: this.state.outgoing.length }, rates: this.rates,
      queueBytes: { downloads: queueBytes(this.incoming), uploads: queueBytes(this.state.outgoing) },
      pendingRequests: this.peer.pendingRequests + this.local.pendingRequests,
      pendingAcks: this.peer.pendingAcks + this.uploadPeer.pendingAcks + this.local.pendingAcks,
      coverageMeaning: "Catch-up covers the initial hour and later gaps; backfill covers only requested older windows. Each window is checked against its selected peer, not the union of all peers. Policy-skipped and unavailable events are counted separately",
      counters: this.counters, lastError: currentError, lastActivity: this.lastActivity, limits: this.config };
  }
  stop() { this.stopped = true; this.local.close(); this.peer.close(); this.livePeer.close(); this.uploadPeer.close(); }
}
