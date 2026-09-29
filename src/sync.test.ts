import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { mergeCoverage, parseSyncConfig } from "./sync.ts";
import { splitWindow, Regulator } from "./sync-protocol.ts";
import { SyncEngine } from "./sync.ts";
import { Negentropy, NegentropyStorageVector, bytesToHex, hexToBytes } from "./negentropy.ts";
import type { NostrEvent } from "nostr-tools";
import { SyncSessions, validateAuth, validateProof } from "./sync-sessions.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("native synchronization boundaries", () => {
  it("uses 25 IDs and 1 request/second without accepting unbounded settings", () => {
    const config = parseSyncConfig({ localRelay: "ws://localhost/relay", peers: ["wss://relay.ditto.pub"] });
    assert.equal(config.batchSize, 25); assert.equal(config.requestIntervalMs, 1000);
    assert.throws(() => parseSyncConfig({ ...config, maxQueue: 0 }));
    assert.throws(() => parseSyncConfig({ ...config, peers: ["https://relay.ditto.pub"] }));
  });
  it("splits inclusive history windows without gaps or overlap", () => {
    assert.deepEqual(splitWindow({ since: 1, until: 4 }), [{ since: 1, until: 2 }, { since: 3, until: 4 }]);
    assert.throws(() => splitWindow({ since: 1, until: 1 }));
    assert.deepEqual(mergeCoverage([{ since: 3, until: 4 }, { since: 1, until: 2 }, { since: 9, until: 10 }]), [{ since: 1, until: 4 }, { since: 9, until: 10 }]);
  });
  it("serializes concurrent calls to the rate regulator", async () => {
    const gate = new Regulator(30); const times: number[] = [];
    await Promise.all([1, 2, 3].map(async () => { await gate.wait(); times.push(Date.now()); }));
    assert.ok(times[1] - times[0] >= 20); assert.ok(times[2] - times[1] >= 20);
  });
  it("binds NIP98 proof to exact URL, method, freshness and signature", () => {
    const key = generateSecretKey(); const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent({ kind: 27235, created_at: now, tags: [["u", "http://localhost/relay-sync/session"], ["method", "POST"]], content: "" }, key);
    assert.equal(validateProof(event, "http://localhost/relay-sync/session"), true);
    assert.equal(validateProof(event, "http://evil.example/session"), false);
    assert.equal(validateProof(event, "http://localhost/relay-sync/session", (now + 120) * 1000), false);
  });
  it("binds NIP42 response to user, socket challenge and relay", () => {
    const key = generateSecretKey(); const pubkey = getPublicKey(key);
    const event = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [["relay", "ws://localhost/relay"], ["challenge", "test"]], content: "" }, key);
    assert.equal(validateAuth(event, pubkey, "test", "ws://localhost/relay"), true);
    assert.equal(validateAuth(event, pubkey, "other", "ws://localhost/relay"), false);
    assert.equal(validateAuth(event, getPublicKey(generateSecretKey()), "test", "ws://localhost/relay"), false);
  });
  it("retains scoped private publications and history checkpoints across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nosu-sync-"));
    const config = parseSyncConfig({ localRelay: "ws://localhost/relay", peers: ["wss://relay.ditto.pub"], maxQueue: 25 });
    const store = { queryItems: async () => [] };
    const key = generateSecretKey(), pubkey = getPublicKey(key);
    const event = finalizeEvent({ kind: 4, created_at: 100, tags: [["p", pubkey]], content: "encrypted fixture" }, key);
    try {
      const first = new SyncEngine(config, store, directory); await first.load();
      first.state.coverage = [{ since: 10000, until: 13599 }]; first.state.pending = [];
      await first.queueUserPublication(pubkey, event);
      const restarted = new SyncEngine(config, store, directory); await restarted.load();
      assert.deepEqual(restarted.state.coverage, [{ since: 10000, until: 13599 }]);
      assert.deepEqual(restarted.userOutbox(pubkey).map(item => item.id), [event.id]);
      assert.equal(restarted.userOutbox(getPublicKey(generateSecretKey())).length, 0);
      await restarted.acknowledgeUserPublication(pubkey, event.id);
      const acknowledged = new SyncEngine(config, store, directory); await acknowledged.load();
      assert.equal(acknowledged.userOutbox(pubkey).length, 0);
      await acknowledged.control("backfill");
      assert.deepEqual(acknowledged.state.pending, [{ kind: "backfill", since: 6400, until: 9999 }]);
      const backfill = new SyncEngine(config, store, directory); await backfill.load();
      assert.deepEqual(backfill.state.pending, [{ kind: "backfill", since: 6400, until: 9999 }]);
      await assert.rejects(backfill.control("backfill"), /finish current coverage/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("classifies saved automatic gaps and requested older windows separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nosu-sync-jobs-"));
    const config = parseSyncConfig({ localRelay: "ws://localhost/relay", peers: ["wss://relay.ditto.pub"] });
    const store = { queryItems: async () => [] };
    try {
      await writeFile(join(directory, "sync.json"), JSON.stringify({ version: 1, coverage: [{ since: 100, until: 200 }], pending: [{ since: 201, until: 300 }, { since: 1, until: 99 }], outgoing: [] }));
      const engine = new SyncEngine(config, store, directory); await engine.load();
      assert.deepEqual(engine.state.pending.map(job => job.kind), ["catchup", "backfill"]);
      engine.jobMetrics.catchup.reconciliations = 2;
      engine.jobMetrics.backfill.accepted = 3;
      const status = engine.status();
      assert.equal(status.catchup.pendingWindows, 1);
      assert.equal(status.backfill.pendingWindows, 1);
      assert.equal(status.catchup.reconciliations, 2);
      assert.equal(status.catchup.accepted, 0);
      assert.equal(status.backfill.accepted, 3);
      assert.equal(status.backfill.reconciliations, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("live recovery diagnostics", () => {
  it("clears the live warning on successful resubscription without hiding other failures", async () => {
    const engine = new SyncEngine(parseSyncConfig({ localRelay: "ws://localhost/relay", peers: ["wss://relay.ditto.pub"] }), { queryItems: async () => [] }, "/tmp/unused-sync-test");
    let connected = false;
    Object.defineProperty(engine.livePeer, "connected", { get: () => connected });
    engine.livePeer.connect = async () => { connected = true; };
    engine.livePeer.subscribe = async () => { throw new Error("subscription failed"); };
    engine.livePeer.onFailure!(new Error("live queue full"));
    assert.equal(engine.status().live.error, "live queue full");
    await assert.rejects(engine.reconnectLive(), /subscription failed/);
    assert.equal(engine.status().live.error, "live queue full");
    engine.livePeer.subscribe = async () => {};
    engine.lastError = "historical request failed";
    await engine.reconnectLive();
    const status = engine.status();
    assert.equal(status.live.state, "live");
    assert.equal(status.live.error, null);
    assert.ok(status.live.recoveredAt);
    assert.equal(status.lastError, "historical request failed");
    assert.equal(status.phase, "attention");
    engine.lastError = null;
    assert.equal(engine.status().lastError, null);
  });
});

describe("private history recovery", () => {
  it("retries a transient history failure on the same authenticated session", async () => {
    let attempts = 0;
    const socket = () => ({ connected: true, authenticated: true, subscribe: async () => {}, close: () => {} });
    const engine = {
      config: { peers: ["wss://relay.ditto.pub/"] }, paused: false,
      fullUserHistory: async () => { if (++attempts === 1) throw new Error("temporary relay refusal"); },
    } as unknown as SyncEngine;
    const sessions = new SyncSessions(engine, "http://localhost/relay-sync", "http://localhost");
    const token = "test";
    const session = {
      token, pubkey: "a".repeat(64), expiresAt: Date.now() + 60000,
      local: socket(), peer: socket(), challenges: new Map(),
      syncing: false, completed: false, error: null, queue: [], stopping: false,
      retryDelayMs: 5,
    };
    // Exercise the session's timed recovery with local in-memory relay doubles.
    (sessions as unknown as { sessions: Map<string, unknown> }).sessions.set(token, session);
    try {
      await (sessions as unknown as { sync: (value: unknown) => Promise<void> }).sync(session);
      assert.ok(session.error); assert.equal(session.completed, false);
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      assert.equal(attempts, 2); assert.equal(session.completed, true);
      assert.equal(session.error, null);
    } finally { sessions.stop(); }
  });
});

describe("native WebSocket reconciliation and transfers", () => {
  it("imports 60 signed events in 25/25/10 batches and avoids repeat transfer", async () => {
    const key = generateSecretKey(), now = Math.floor(Date.now() / 1000);
    const remote = Array.from({ length: 60 }, (_, index) => finalizeEvent({ kind: 1, created_at: now, tags: [], content: String(index) }, key));
    const local = new Map<string, NostrEvent>(); const batches: number[] = [];
    const sessions = new Map<string, Negentropy>();
    const server = Bun.serve({ port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("fixture"); },
      websocket: { message(ws, message) {
        const frame = JSON.parse(String(message));
        if (frame[0] === "NEG-OPEN") {
          const vector = new NegentropyStorageVector(); for (const event of remote) vector.insertHex(event.created_at, event.id); vector.seal();
          const neg = new Negentropy(vector, 16384); sessions.set(frame[1], neg);
          const result = neg.reconcile(hexToBytes(frame[3])); ws.send(JSON.stringify(["NEG-MSG", frame[1], bytesToHex(result.message!)]));
        } else if (frame[0] === "NEG-MSG") {
          const result = sessions.get(frame[1])!.reconcile(hexToBytes(frame[2]));
          ws.send(JSON.stringify(["NEG-MSG", frame[1], bytesToHex(result.message!)]));
        } else if (frame[0] === "REQ") {
          const ids: string[] = frame[2].ids; batches.push(ids.length);
          for (const event of remote.filter(event => ids.includes(event.id))) ws.send(JSON.stringify(["EVENT", frame[1], event]));
          ws.send(JSON.stringify(["EOSE", frame[1]]));
        } else if (frame[0] === "EVENT") {
          local.set(frame[1].id, frame[1]); ws.send(JSON.stringify(["OK", frame[1].id, true, ""]));
        }
      } },
    });
    const config = parseSyncConfig({ localRelay: `ws://localhost:${server.port}`, peers: [`ws://localhost:${server.port}`], requestIntervalMs: 5, uploadIntervalMs: 5 });
    const engine = new SyncEngine(config, { queryItems: async () => [...local.values()].map(event => ({ id: event.id, created_at: event.created_at })) }, "/tmp/unused-sync-test");
    try {
      await Promise.all([engine.peer.connect(), engine.local.connect()]);
      await engine.transferWindow({ since: now - 1, until: now });
      assert.equal(local.size, 60); assert.deepEqual(batches, [25, 25, 10]);
      await engine.transferWindow({ since: now - 1, until: now }); assert.equal(batches.length, 3);
    } finally { engine.stop(); server.stop(true); }
  });
});
