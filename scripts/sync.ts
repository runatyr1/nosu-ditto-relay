import { readFile } from "node:fs/promises";
import type { NostrEvent } from "nostr-tools";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";
import { parseSyncConfig, SyncEngine } from "../src/sync.ts";
import { SyncSessions } from "../src/sync-sessions.ts";

const config = parseSyncConfig(JSON.parse(await readFile(process.env.SYNC_CONFIG ?? "/config/sync.json", "utf8")));
const relayConfig = new Config({ get: (key) => process.env[key] });
const store = OpenSearchRelay.fromConfig(relayConfig);
const engine = new SyncEngine(config, store, process.env.SYNC_STATE_DIR ?? "/data", await relayConfig.nostrSigner.getPublicKey());
const origin = process.env.SYNC_CLIENT_ORIGIN ?? "http://localhost";
const sessions = new SyncSessions(engine, process.env.SYNC_PUBLIC_URL ?? `${origin}/relay-sync`, origin);
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function body(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 16384) throw new Error("request body too large");
  const reader = req.body?.getReader(); if (!reader) throw new Error("missing request body");
  let total = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength;
    if (total > 16384) { await reader.cancel(); throw new Error("request body too large"); } chunks.push(value); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const server = Bun.serve({
  port: Number(process.env.PORT ?? 13132), maxRequestBodySize: 16384,
  async fetch(req) {
    const path = new URL(req.url).pathname; const requestOrigin = req.headers.get("origin");
    try {
      if (path === "/" || path === "/health/live") return response({ ok: true });
      if (path === "/capabilities" && req.method === "GET") return response(sessions.capabilities());
      if (path === "/status" && req.method === "GET" && !requestOrigin) return response({ ...engine.status(), sessions: sessions.status() });
      if (path === "/control" && req.method === "POST" && !requestOrigin) {
        await engine.control((await body(req)).action); return response(engine.status());
      }
      if (path === "/session" || path.startsWith("/session/")) {
        const sameOriginGet = req.method === "GET" && !requestOrigin && req.headers.get("sec-fetch-site") === "same-origin";
        if (requestOrigin !== origin && !sameOriginGet) return response({ error: "origin not allowed" }, 403);
        const authorization = req.headers.get("authorization") ?? "";
        if (path === "/session" && req.method === "POST") {
          if (!authorization.startsWith("Nostr ") || authorization.length > 16384) return response({ error: "NIP-98 proof required" }, 401);
          const proof = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString("utf8")) as NostrEvent;
          return response(await sessions.register(proof));
        }
        if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return response({ error: "session token required" }, 401);
        const token = authorization.slice(7);
        if (path === "/session/challenges" && req.method === "GET") return response(sessions.challenges(token));
        if (path === "/session/auth" && req.method === "POST") {
          const input = await body(req); return response(await sessions.auth(token, input.id, input.event));
        }
        if (path === "/session/publish" && req.method === "POST") return response(await sessions.publish(token, (await body(req)).event));
        if (path === "/session" && req.method === "DELETE") { sessions.revoke(token); return response({ revoked: true }); }
      }
      return response({ error: "not found" }, 404);
    } catch (error) { return response({ error: (error as Error).message.slice(0, 200) }, 400); }
  },
});
void engine.run().catch(() => { console.error(JSON.stringify({ level: "error", msg: "sync_start_failed" })); process.exit(1); });
console.log(JSON.stringify({ level: "info", msg: "sync_started", port: server.port, batch_size: config.batchSize, request_interval_ms: config.requestIntervalMs }));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  engine.stop(); sessions.stop(); server.stop();
  void engine.save().then(() => process.exit(0), () => process.exit(1));
});
