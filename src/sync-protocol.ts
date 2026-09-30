/** Native NIP-77 orchestration. Negentropy codec and admission remain Ditto's. */
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Filter, NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { bytesToHex, hexToBytes, Negentropy, NegentropyStorageVector } from "./negentropy.ts";

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class CapacityError extends Error {}
export class AdmissionError extends Error {}
export interface SyncLimits {
  batchSize: number; requestIntervalMs: number; uploadIntervalMs: number;
  maxQueue: number; maxQueueBytes: number; maxItems: number; maxMessageBytes: number; bandwidthBytesPerSecond: number;
}
export const DEFAULT_LIMITS: SyncLimits = {
  batchSize: 25, requestIntervalMs: 1000, uploadIntervalMs: 1000,
  maxQueue: 2000, maxQueueBytes: 16777216, maxItems: 100000, maxMessageBytes: 4194304, bandwidthBytesPerSecond: 1048576,
};
export function queueBytes(events: NostrEvent[]) { return events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0); }
export interface SyncCounters { requests: number; downloaded: number; uploaded: number; rejected: number; retries: number; bytes: number; policySkipped: number; missingAtTransfer: number }
export class Regulator {
  private tail = Promise.resolve();
  private downloads = Promise.resolve();
  private next = 0;
  constructor(readonly interval: number) {}
  async wait(): Promise<void> {
    const turn = this.tail.then(async () => {
      await delay(Math.max(0, this.next - Date.now()));
      this.next = Date.now() + this.interval;
    });
    this.tail = turn.catch(() => {});
    await turn;
  }
  async download<T>(operation: () => Promise<T>): Promise<T> {
    const turn = this.downloads.then(operation);
    this.downloads = turn.then(() => {}, () => {});
    return turn;
  }
}
type Frame = unknown[];
type FrameListener = (frame: Frame) => void;
/** One socket owns bounded multiplexed requests; no event content is logged. */
export class SyncSocket {
  ws: WebSocket | undefined;
  challenge: string | undefined;
  authenticated = false;
  private listeners = new Set<FrameListener>();
  private nextBytes = 0;
  pendingRequests = 0;
  pendingAcks = 0;
  readonly traffic = { receivedBytes: 0, queries: 0, subscriptions: 0 };
  onEvent?: (event: NostrEvent, sub: string) => void;
  onClosed?: (sub: string, reason: string) => void;
  onDisconnect?: () => void;
  onChallenge?: (challenge: string) => void;
  onFailure?: (error: Error) => void;
  constructor(readonly url: string, readonly limits: SyncLimits, readonly requests: Regulator,
    readonly uploads: Regulator, readonly counters: SyncCounters) {}
  get connected() { return this.ws?.readyState === 1; }
  async connect() {
    if (this.connected) return;
    const ws = new WebSocket(this.url);
    this.ws = ws; this.authenticated = false; this.challenge = undefined;
    ws.addEventListener("message", ({ data }) => {
      if (this.ws !== ws) return;
      const text = typeof data === "string" ? data : "";
      if (Buffer.byteLength(text) > this.limits.maxMessageBytes) {
        this.onFailure?.(new CapacityError("peer message exceeds configured size")); ws.close(); return;
      }
      this.counters.bytes += Buffer.byteLength(text);
      this.traffic.receivedBytes += Buffer.byteLength(text);
      try {
        const frame = JSON.parse(text) as Frame;
        if (!Array.isArray(frame)) return;
        if (frame[0] === "AUTH" && typeof frame[1] === "string") {
          this.challenge = frame[1]; this.onChallenge?.(frame[1]);
        }
        for (const listener of [...this.listeners]) listener(frame);
        if (frame[0] === "CLOSED" && typeof frame[1] === "string") this.onClosed?.(frame[1], String(frame[2]));
        if (frame[0] === "EVENT" && typeof frame[1] === "string" && frame[2]) {
          this.onEvent?.(frame[2] as NostrEvent, frame[1]);
        }
      } catch { /* A malformed peer frame cannot alter local state. */ }
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.authenticated = false;
      for (const listener of [...this.listeners]) listener(["DISCONNECTED"]);
      this.onDisconnect?.();
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { ws.close(); reject(new Error("relay connection timeout")); }, 15000);
      ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("relay connection failed")); }, { once: true });
    });
  }
  close() { this.ws?.close(); }
  private watch<T>(receive: (frame: Frame, resolve: (value: T) => void, reject: (error: Error) => void) => void,
    send: () => Promise<void>, timeoutMs = 60000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: Error, value?: T) => {
        clearTimeout(timer); this.listeners.delete(listener);
        if (error) reject(error); else resolve(value as T);
      };
      const listener: FrameListener = (frame) => {
        if (frame[0] === "DISCONNECTED") return finish(new Error("relay disconnected"));
        try { receive(frame, (value) => finish(undefined, value), (error) => finish(error)); }
        catch (error) { finish(error as Error); }
      };
      const timer = setTimeout(() => finish(new Error("relay response timeout")), timeoutMs);
      this.listeners.add(listener);
      void send().catch((error: Error) => finish(error));
    });
  }
  async send(frame: Frame) {
    if (!this.connected) throw new Error("relay is disconnected");
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text);
    if (bytes > this.limits.maxMessageBytes) throw new CapacityError("outgoing event exceeds message size");
    await delay(Math.max(0, this.nextBytes - Date.now()));
    this.nextBytes = Date.now() + bytes * 1000 / this.limits.bandwidthBytesPerSecond;
    if (!this.connected) throw new Error("relay disconnected while regulating traffic");
    this.ws!.send(text); this.counters.bytes += bytes;
  }
  async query(filter: Filter, timeoutMs = 60000): Promise<NostrEvent[]> {
    return this.requests.download(() => this.queryBatch(filter, timeoutMs));
  }
  private async queryBatch(filter: Filter, timeoutMs: number): Promise<NostrEvent[]> {
    const sub = randomUUID(); const events = new Map<string, NostrEvent>();
    this.pendingRequests++;
    try {
      return await this.watch((frame, resolve, reject) => {
        if (frame[1] !== sub) return;
        if (frame[0] === "EVENT") {
          const event = frame[2] as NostrEvent;
          if (!verifyEvent(event)) return reject(new Error("peer returned invalid signature"));
          events.set(event.id, event);
          if (events.size > this.limits.maxQueue) reject(new CapacityError("download batch exceeds queue cap"));
        } else if (frame[0] === "EOSE") resolve([...events.values()]);
        else if (frame[0] === "CLOSED") reject(new AdmissionError(String(frame[2])));
      }, async () => { await this.requests.wait(); this.counters.requests++; this.traffic.queries++; await this.send(["REQ", sub, filter]); }, timeoutMs);
    } finally { this.pendingRequests--; if (this.connected) await this.send(["CLOSE", sub]); }
  }
  async publish(event: NostrEvent) {
    if (!verifyEvent(event)) throw new AdmissionError("invalid event signature");
    this.pendingAcks++;
    try { await this.watch<void>((frame, resolve, reject) => {
      if (frame[0] !== "OK" || frame[1] !== event.id) return;
      if (frame[2] === true || String(frame[3]).startsWith("duplicate:")) resolve();
      else if (/^(error:|rate-limited:)/.test(String(frame[3]))) reject(new Error(String(frame[3])));
      else reject(new AdmissionError(String(frame[3])));
    }, async () => { await this.uploads.wait(); await this.send(["EVENT", event]); });
    } finally { this.pendingAcks--; }
  }
  async auth(event: NostrEvent) {
    await this.watch<void>((frame, resolve, reject) => {
      if (frame[0] === "OK" && frame[1] === event.id) {
        if (frame[2] === true) { this.authenticated = true; resolve(); }
        else reject(new AdmissionError("relay rejected authentication"));
      }
    }, () => this.send(["AUTH", event]));
  }
  async subscribe(sub: string, filters: Filter[]) {
    await this.watch<void>((frame, resolve, reject) => {
      if (frame[1] !== sub) return;
      if (frame[0] === "EOSE") resolve();
      else if (frame[0] === "CLOSED") reject(new AdmissionError(String(frame[2])));
    }, async () => {
      await this.requests.wait(); this.counters.requests++; this.traffic.subscriptions++;
      await this.send(["REQ", sub, ...filters.map((filter) => ({ ...filter, limit: 0 }))]);
    }, 15000);
  }
  async reconcile(filter: Filter, items: { created_at: number; id: string }[], timeoutMs = 300000): Promise<{ need: string[]; have: string[] }> {
    if (items.length >= this.limits.maxItems) throw new CapacityError("local reconciliation set exceeds cap");
    const storage = new NegentropyStorageVector();
    for (const item of items) storage.insertHex(item.created_at, item.id);
    storage.seal(); const neg = new Negentropy(storage, 16384); const sub = randomUUID();
    let rounds = 0;
    try {
      return await this.watch<{ need: string[]; have: string[] }>((frame, resolve, reject) => {
        if (frame[1] !== sub) return;
        if (frame[0] === "NEG-ERR") {
          const reason = String(frame[2]);
          reject(/too many records|query matches|record.*(?:cap|limit)|set exceeds/i.test(reason) ? new CapacityError(reason) : new Error(reason));
        } else if (frame[0] === "NEG-MSG") {
          const result = neg.reconcile(hexToBytes(String(frame[2])));
          if (result.needIds.length >= this.limits.maxItems || ++rounds > 1000) return reject(new CapacityError("remote reconciliation set exceeds cap"));
          if (!result.message) resolve({ need: [...new Set(result.needIds)], have: [...new Set(result.haveIds)] });
          else void this.requests.wait().then(() => {
            this.counters.requests++; return this.send(["NEG-MSG", sub, bytesToHex(result.message!)]);
          }).catch(reject);
        }
      }, async () => {
        await this.requests.wait(); this.counters.requests++;
        await this.send(["NEG-OPEN", sub, filter, bytesToHex(neg.initiate())]);
      }, timeoutMs);
    } finally { if (this.connected) await this.send(["NEG-CLOSE", sub]); }
  }
}

export interface Window { since: number; until: number }
/** Inclusive Nostr endpoints must not overlap when a capped set is split. */
export function splitWindow(window: Window): [Window, Window] {
  if (window.since >= window.until) throw new CapacityError("one-second history window exceeds capacity; narrow event kinds/authors");
  const mid = Math.floor((window.since + window.until) / 2);
  return [{ since: window.since, until: mid }, { since: mid + 1, until: window.until }];
}
