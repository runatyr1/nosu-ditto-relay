/** Browser signers authenticate their own relay sockets; this worker never owns user keys. */
import { randomBytes, randomUUID } from "node:crypto";
import type { NostrEvent, Filter } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { AdmissionError, delay, Regulator, SyncSocket, queueBytes } from "./sync-protocol.ts";
import type { SyncEngine } from "./sync.ts";

interface Challenge { id: string; relay: string; challenge: string; socket: SyncSocket }
interface Session {
  token: string; pubkey: string; expiresAt: number; local: SyncSocket; peer: SyncSocket;
  challenges: Map<string, Challenge>; syncing: boolean; completed: boolean; error: string | null;
  queue: { event: NostrEvent; destination: SyncSocket }[]; stopping: boolean;
  retryTimer?: ReturnType<typeof setTimeout>; retryDelayMs: number;
}
export function validateProof(event: NostrEvent, url: string, now = Date.now()) {
  if (!verifyEvent(event) || event.kind !== 27235 || Math.abs(now / 1000 - event.created_at) > 60 || event.content !== "") return false;
  return event.tags.filter(([tag]) => tag === "u").length === 1 && event.tags.some(([tag, value]) => tag === "u" && value === url)
    && event.tags.filter(([tag]) => tag === "method").length === 1 && event.tags.some(([tag, value]) => tag === "method" && value === "POST");
}
export function validateAuth(event: NostrEvent, pubkey: string, challenge: string, relay: string, now = Date.now()) {
  if (!verifyEvent(event) || event.kind !== 22242 || event.pubkey !== pubkey || Math.abs(now / 1000 - event.created_at) > 60 || event.content !== "") return false;
  return event.tags.filter(([tag]) => tag === "relay").length === 1 && event.tags.some(([tag, value]) => tag === "relay" && value === relay)
    && event.tags.filter(([tag]) => tag === "challenge").length === 1 && event.tags.some(([tag, value]) => tag === "challenge" && value === challenge);
}
export class SyncSessions {
  private sessions = new Map<string, Session>();
  private proofs = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;
  private registrations: number[] = [];
  readonly sessionUrl: string; readonly localAuthRelay: string;
  constructor(readonly engine: SyncEngine, readonly publicUrl: string, readonly origin: string) {
    this.sessionUrl = publicUrl.endsWith("/session") ? publicUrl : `${publicUrl.replace(/\/$/, "")}/session`;
    this.localAuthRelay = `${origin.replace(/^http/, "ws")}/relay`;
    this.timer = setInterval(() => {
      for (const [token, session] of this.sessions) if (session.expiresAt < Date.now()) this.revoke(token);
      for (const [id, until] of this.proofs) if (until < Date.now()) this.proofs.delete(id);
    }, 30000);
  }
  capabilities() { return { enabled: true, peer: this.engine.config.peers[0], localRelay: this.localAuthRelay }; }
  status() { return { active: this.sessions.size, syncing: [...this.sessions.values()].filter((s) => s.syncing).length, completed: [...this.sessions.values()].filter((s) => s.completed).length, failed: [...this.sessions.values()].filter((s) => s.error).length }; }
  revoke(token: string) {
    const session = this.sessions.get(token); if (!session) return;
    session.stopping = true; if (session.retryTimer) clearTimeout(session.retryTimer);
    session.local.close(); session.peer.close(); this.sessions.delete(token);
  }
  stop() { clearInterval(this.timer); for (const token of this.sessions.keys()) this.revoke(token); }
  async register(proof: NostrEvent) {
    this.registrations = this.registrations.filter((at) => at > Date.now() - 60000);
    if (this.registrations.length >= 10 || this.sessions.size >= 10) throw new Error("session capacity reached; retry later");
    if (!validateProof(proof, this.sessionUrl) || this.proofs.has(proof.id)) throw new Error("invalid or replayed NIP-98 proof");
    this.registrations.push(Date.now()); this.proofs.set(proof.id, Date.now() + 120000);
    for (const [token, session] of this.sessions) if (session.pubkey === proof.pubkey) this.revoke(token);
    const local = new SyncSocket(this.engine.config.localRelay, this.engine.config, new Regulator(0), new Regulator(0), this.engine.counters);
    const peer = this.engine.socket(this.engine.config.peers[0]);
    const token = randomBytes(32).toString("hex");
    const session: Session = { token, pubkey: proof.pubkey, expiresAt: Date.now() + 3600000, local, peer,
      challenges: new Map(), syncing: false, completed: false, error: null,
      queue: this.engine.userOutbox(proof.pubkey).map(event => ({ event, destination: peer })), stopping: false, retryDelayMs: 30000 };
    const install = (socket: SyncSocket, relay: string) => {
      socket.onChallenge = (challenge) => {
        for (const [id, old] of session.challenges) if (old.socket === socket) session.challenges.delete(id);
        const id = randomUUID(); session.challenges.set(id, { id, challenge, relay, socket });
      };
    };
    install(local, this.localAuthRelay); install(peer, peer.url);
    this.sessions.set(token, session);
    try {
      await Promise.all([local.connect(), peer.connect()]);
      // Ditto sends AUTH lazily on a protected request. A scoped limit-zero
      // subscription prompts challenges without downloading private events.
      await Promise.all([local.subscribe("auth-probe", this.filters(session.pubkey).slice(1)), peer.subscribe("auth-probe", this.filters(session.pubkey).slice(1))]);
    }
    catch { this.revoke(token); throw new Error("could not open authenticated relay connections"); }
    void this.liveLoop(session);
    return { token, pubkey: proof.pubkey, expiresAt: session.expiresAt };
  }
  private find(token: string) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) throw new Error("session expired");
    return session;
  }
  challenges(token: string) {
    const session = this.find(token);
    if (!session.local.connected || !session.peer.connected) throw new Error("relay session disconnected; renew authentication");
    return { challenges: [...session.challenges.values()].map(({ id, challenge, relay }) => ({ id, challenge, relay })),
      status: { authenticated: session.local.authenticated && session.peer.authenticated, syncing: session.syncing, completed: session.completed, error: session.error, queued: session.queue.length } };
  }
  async auth(token: string, id: string, event: NostrEvent) {
    const session = this.find(token); const challenge = session.challenges.get(id);
    if (!challenge || !validateAuth(event, session.pubkey, challenge.challenge, challenge.relay)) throw new Error("invalid NIP-42 response");
    await challenge.socket.auth(event); session.challenges.delete(id);
    if (session.local.authenticated && session.peer.authenticated && !session.syncing && !session.completed) void this.sync(session);
    return { authenticated: true };
  }
  /** Authenticated clients vouch for newly published gift wraps whose sender
   * cannot be identified from the ephemeral outer key. Nothing is decrypted. */
  async publish(token: string, event: NostrEvent) {
    const session = this.find(token);
    if (!verifyEvent(event) || (event.kind !== 1059 && event.pubkey !== session.pubkey)) throw new Error("event does not belong to active session");
    if (event.tags.some(([tag]) => tag === "-") && event.pubkey !== session.pubkey) throw new Error("protected event requires its author's session");
    if (session.queue.some((item) => item.event.id === event.id && item.destination === session.peer)) return { queued: true };
    if (session.queue.length >= this.engine.config.maxQueue || queueBytes([...session.queue.map(item => item.event), event]) > this.engine.config.maxQueueBytes) throw new Error("private outbound queue full");
    await this.engine.queueUserPublication(session.pubkey, event);
    if (session.stopping) throw new Error("session revoked; encrypted publication retained for next sign-in");
    session.queue.push({ event, destination: session.peer });
    return { queued: true };
  }
  private filters(pubkey: string): Filter[] {
    return [{ authors: [pubkey] }, { kinds: [4, 78, 30078], authors: [pubkey] }, { kinds: [4, 1059], "#p": [pubkey] }];
  }
  private async sync(session: Session) {
    session.syncing = true; session.error = null;
    const filters = this.filters(session.pubkey); const until = Math.floor(Date.now() / 1000);
    const enqueue = (event: NostrEvent, destination: SyncSocket) => {
      if (session.queue.some((item) => item.event.id === event.id && item.destination === destination)) return;
      if (session.queue.length >= this.engine.config.maxQueue || queueBytes([...session.queue.map(item => item.event), event]) > this.engine.config.maxQueueBytes) { session.error = "private live queue reached capacity"; session.peer.close(); return; }
      session.queue.push({ event, destination });
    };
    session.peer.onEvent = (event, sub) => { if (sub === "private-peer") enqueue(event, session.local); };
    session.local.onEvent = (event, sub) => {
      if (sub === "private-local" && !this.engine.isImported(event.id)
        && ((event.pubkey === session.pubkey && (event.tags.some(([tag]) => tag === "-") || [4, 78, 30078].includes(event.kind)))
          || (event.kind === 1059 && event.tags.some(([tag, value]) => tag === "p" && value === session.pubkey)))) enqueue(event, session.peer);
    };
    try {
      await session.peer.subscribe("private-peer", filters);
      // Include protected public events authored here; the peer socket is authenticated as author.
      await session.local.subscribe("private-local", [...filters, { authors: [session.pubkey] }]);
      await this.engine.fullUserHistory(filters, session.peer, session.local, until, () => session.stopping);
      session.completed = true; session.retryDelayMs = 30000;
    } catch {
      session.error = "user history sync incomplete; relay access, admission, or connection failed";
      if (!session.stopping && session.expiresAt > Date.now()) {
        const delayMs = session.retryDelayMs;
        session.retryDelayMs = Math.min(300000, delayMs * 2);
        const retry = () => {
          if (session.stopping || session.expiresAt <= Date.now()) return;
          if (this.engine.paused) { session.retryTimer = setTimeout(retry, 30000); return; }
          // A disconnected socket requires fresh NIP-42 challenges through a new browser session.
          if (session.local.connected && session.peer.connected && session.local.authenticated && session.peer.authenticated) void this.sync(session);
        };
        session.retryTimer = setTimeout(retry, delayMs);
      }
    }
    finally { session.syncing = false; }
  }
  private async liveLoop(session: Session) {
    const seen = new Set<string>();
    while (!session.stopping && session.expiresAt > Date.now()) {
      if (!session.queue.length || this.engine.paused) { await delay(250); continue; }
      const item = session.queue[0];
      if (seen.has(item.event.id)) { session.queue.shift(); continue; }
      try {
        // Mark before publication so imported ciphertext is not echoed from the local live subscription.
        if (!session.peer.authenticated || !session.local.authenticated) { await delay(1000); continue; }
        await this.engine.importEvent(item.event, item.destination);
        if (item.destination === session.peer) await this.engine.acknowledgeUserPublication(session.pubkey, item.event.id);
        seen.add(item.event.id);
        if (seen.size > this.engine.config.maxItems) seen.delete(seen.values().next().value!);
        session.queue.shift();
      } catch (error) {
        session.error = "private event transfer rejected or disconnected";
        if (error instanceof AdmissionError) session.queue.shift();
        else await delay(5000);
      }
    }
  }
}
