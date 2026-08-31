/**
 * Import Nostr events from a JSONL dump (optionally zstd-compressed) into
 * the relay's OpenSearch index.
 *
 * This is the inverse of `scripts/export.ts`, but it is not a naive reversal
 * of it, because the target index is usually a live relay that already holds
 * overlapping data. Three things follow from that, and they are the reason
 * this script has three phases instead of one loop:
 *
 *  1. **Never overwrite an existing document.** A document rebuilt from a
 *     bare event carries `deleted: false`, `replaced: false` and zeroed
 *     score fields, so overwriting a live one would discard its engagement
 *     counts and resurrect anything soft-deleted. Ingest therefore issues
 *     `create` operations (see `OpenSearchRelay.importEvents`) and an event
 *     already present is skipped untouched. The whole import is idempotent:
 *     re-running it over the same dump is safe and cheap.
 *
 *  2. **Replaceable slots must be reconciled after the fact.** A dump holds
 *     every historical version of every profile and contact list. Writing
 *     them all leaves several `replaced: false` documents in one slot, and
 *     queries would return a user's 2025 profile alongside their current
 *     one. Phase `slots` resolves each touched slot once, after ingest, when
 *     every version is searchable — `resolveSlotsFor` picks the NIP-01
 *     winner over all visible versions, so an imported old profile loses to
 *     the newer one the relay already served.
 *
 *  3. **Deletion requests must be honored, not just stored.** Kind 5 is
 *     ~12% of a Ditto dump. Storing those events without applying them
 *     would republish content their authors asked to erase. Phase
 *     `deletions` replays them using the same authorization rules as the
 *     live ingest path (`canDelete` / `authorizedATagFilters` in
 *     `src/deletions.ts`), batched so that millions of requests cost
 *     thousands of round trips rather than millions.
 *
 * Progress is checkpointed by line number, so an interrupted run resumes
 * without re-sending anything.
 *
 * Usage:
 *   bun run scripts/import.ts <dump.jsonl[.zst]> [options]
 *
 * Options:
 *   --phase <all|ingest|slots|deletions>  Phase to run (default: all)
 *   --index <name>        Override OPENSEARCH_INDEX
 *   --batch <n>           Events per bulk request (default: 1000)
 *   --concurrency <n>     In-flight bulk requests (default: 4). This is the
 *                         throttle: lower it to lean on the cluster less.
 *   --limit <n>           Stop after n events (for smoke tests)
 *   --work-dir <dir>      Where sidecar/checkpoint files live
 *                         (default: alongside the dump)
 *   --resume              Continue from the checkpoint
 *   --no-verify-ids       Skip the SHA-256 event id check
 *   --dry-run             Parse and validate, write nothing
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { NKinds } from "@nostrify/nostrify";
import { file as bunFile, spawn as bunSpawn, type Subprocess } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import { Config } from "../src/config.ts";
import {
  applyVanishRequest,
  authorizedATagFilters,
  canDelete,
  eTagTargets,
} from "../src/deletions.ts";
import { Logger } from "../src/log.ts";
import { OpenSearchRelay, type SlotEvent } from "../src/opensearch.ts";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Phase = "all" | "ingest" | "slots" | "deletions";

interface Options {
  file: string;
  phase: Phase;
  index?: string;
  batch: number;
  concurrency: number;
  limit: number;
  workDir: string;
  resume: boolean;
  verifyIds: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (name === "resume" || name === "no-verify-ids" || name === "dry-run") {
        flags.set(name, "true");
      } else {
        flags.set(name, argv[++i] ?? "");
      }
    } else {
      positional.push(arg);
    }
  }

  const file = positional[0];
  if (!file) {
    console.error("Usage: bun run scripts/import.ts <dump.jsonl[.zst]>");
    process.exit(1);
  }

  const num = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      console.error(`Invalid --${name}: ${raw}`);
      process.exit(1);
    }
    return value;
  };

  const phase = (flags.get("phase") ?? "all") as Phase;
  if (!["all", "ingest", "slots", "deletions"].includes(phase)) {
    console.error(`Invalid --phase: ${phase}`);
    process.exit(1);
  }

  return {
    file,
    phase,
    index: flags.get("index"),
    batch: num("batch", 1000),
    concurrency: num("concurrency", 4),
    limit: num("limit", 0),
    workDir: flags.get("work-dir") ?? dirname(file),
    resume: flags.has("resume"),
    verifyIds: !flags.has("no-verify-ids"),
    dryRun: flags.has("dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

/** ASCII line feed, the dump's record separator. */
const NEWLINE = 0x0a;

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/**
 * Structural check on a parsed dump line.
 *
 * Deliberately shallow: it rejects anything that would poison the index
 * mapping or produce a nonsense document, and leaves cryptographic identity
 * to {@link hasValidId}.
 */
function isWellFormed(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;

  return (
    typeof event.id === "string" &&
    HEX_64.test(event.id) &&
    typeof event.pubkey === "string" &&
    HEX_64.test(event.pubkey) &&
    typeof event.sig === "string" &&
    HEX_128.test(event.sig) &&
    typeof event.kind === "number" &&
    Number.isInteger(event.kind) &&
    event.kind >= 0 &&
    typeof event.created_at === "number" &&
    Number.isInteger(event.created_at) &&
    event.created_at >= 0 &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) => Array.isArray(tag) && tag.every((v) => typeof v === "string"),
    )
  );
}

/**
 * Whether the event's `id` is the SHA-256 of its NIP-01 serialization.
 *
 * This catches dump corruption and mismatched ids without the cost of full
 * signature verification. It does NOT prove authenticity: an id can be
 * recomputed for tampered content. Only run an import from a dump you
 * trust, or verify signatures separately.
 */
function hasValidId(event: NostrEvent): boolean {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return createHash("sha256").update(serialized).digest("hex") === event.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slot key for a replaceable/addressable event: `kind:pubkey:dTag`. */
function slotKey(event: SlotEvent): string {
  const dTag = NKinds.addressable(event.kind)
    ? (event.tags.find(([name]) => name === "d")?.[1] ?? "")
    : "";
  return `${event.kind}:${event.pubkey}:${dTag}`;
}

/** Whether this event occupies a replaceable/addressable slot. */
function isSlotted(event: Pick<NostrEvent, "kind">): boolean {
  return NKinds.replaceable(event.kind) || NKinds.addressable(event.kind);
}

/** Drop the fields slot resolution never reads, to keep the sidecar small. */
function trimToSlot(event: NostrEvent): SlotEvent {
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    created_at: event.created_at,
    tags: event.tags,
  };
}

/** Whether this event asks the relay to delete something. */
function isDeletionRequest(event: NostrEvent): boolean {
  return event.kind === 5 || event.kind === 62;
}

/**
 * Split a byte stream into lines, pulling from it only as fast as the
 * consumer iterates.
 *
 * Web streams, not `node:stream` — and this is load-bearing rather than
 * stylistic. Under Bun, a `node:child_process` stdout pipe is drained into
 * memory regardless of how slowly the consumer reads: neither
 * `readline.createInterface`, nor `for await` over the Readable, nor
 * explicit paused-mode `read()` throttles it. Importing this dump reached
 * 43 GB RSS in three minutes on a host whose OpenSearch already holds 70 GB
 * of 128 GB. Measured against the same dump with a consumer throttled to
 * ~2.5k lines/s, the three `node:stream` approaches all passed 8 GB within
 * 40 seconds while this one held flat at 2.8 GB.
 *
 * The generator is what makes it work: `reader.read()` is only reached once
 * the buffered lines are exhausted and the consumer asks for another, so the
 * pipe stays throttled to the speed of the import.
 */
async function* splitLines(
  stream: ReadableStream<Uint8Array>,
  cursor: { offset: number },
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  /** Bytes of a trailing partial line, carried into the next chunk. */
  let carry: Uint8Array | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      let chunk = value;
      if (carry !== null) {
        const merged = new Uint8Array(carry.length + chunk.length);
        merged.set(carry);
        merged.set(chunk, carry.length);
        chunk = merged;
        carry = null;
      }

      // Split on bytes and decode each line on its own. Slicing the decoded
      // chunk as a string instead would be the obvious implementation and is
      // a trap: a JavaScriptCore substring shares its parent's backing store,
      // so every line handed to the caller pins the entire chunk it came
      // from, and the process grows without ever holding anything it needs.
      // `decode` of a subarray returns a standalone string that owns its
      // bytes, and the carry is copied out with `slice` for the same reason.
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(NEWLINE, start);
        if (newline === -1) break;
        // Counted before the yield so the cursor always covers every line
        // the consumer has been handed, which is what the checkpoint means.
        cursor.offset += newline - start + 1;
        yield decoder.decode(chunk.subarray(start, newline));
        start = newline + 1;
      }

      if (start < chunk.length) carry = chunk.slice(start);
    }

    if (carry !== null && carry.length > 0) {
      cursor.offset += carry.length;
      yield decoder.decode(carry);
    }
  } finally {
    reader.releaseLock();
  }
}

/** A positioned line reader over a dump. */
interface LineReader {
  lines: AsyncIterable<string>;
  /** Byte offset just past the last line handed to the consumer. */
  position: () => number;
  /** Whether this reader honored `startOffset`. */
  seekable: boolean;
  close: () => void;
}

/**
 * Line-oriented reader for a dump, transparently decompressing `.zst`.
 *
 * A plain file can be opened at a byte offset, which is what makes a resume
 * free. A `.zst` stream cannot — zstd has to decompress from the start — so
 * resuming one costs a re-read of everything already done, and the caller
 * falls back to counting lines. For a dump this size that is minutes per
 * restart, so decompressing it once and importing the plain file is well
 * worth the disk.
 */
function readLines(file: string, startOffset = 0): LineReader {
  const cursor = { offset: 0 };

  if (!file.endsWith(".zst")) {
    cursor.offset = startOffset;
    return {
      lines: splitLines(bunFile(file).slice(startOffset).stream(), cursor),
      position: () => cursor.offset,
      seekable: true,
      close: () => {},
    };
  }

  let proc: Subprocess<"ignore", "pipe", "inherit">;
  try {
    proc = bunSpawn(["zstd", "-dcq", "--long=27", file], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
  } catch (error) {
    console.error(
      `Failed to run zstd: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  return {
    lines: splitLines(proc.stdout, cursor),
    position: () => cursor.offset,
    seekable: false,
    close: () => proc.kill(),
  };
}

/**
 * Bounded pool of in-flight promises.
 *
 * This is the importer's only throttle, and deliberately so. An earlier
 * events-per-second cap that slept between batches turned out to make the
 * process grow without bound — measured on this dump, ingest capped at 10k/s
 * passed 12 GB RSS within a minute, while the same run uncapped held flat at
 * 0.3 GB and went faster. Limiting how many bulk requests may be outstanding
 * paces the cluster just as well and never parks the pipeline.
 */
class Pool {
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly limit: number) {}

  async run(task: () => Promise<void>): Promise<void> {
    const promise = task().finally(() => {
      this.inFlight.delete(promise);
    });
    this.inFlight.add(promise);
    if (this.inFlight.size >= this.limit) {
      await Promise.race(this.inFlight);
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.inFlight);
  }
}

interface Checkpoint {
  /** Byte offset into the dump; only meaningful for a seekable reader. */
  offset: number;
  lines: number;
  created: number;
  skipped: number;
  failed: number;
  invalid: number;
}

const ZERO: Checkpoint = {
  offset: 0,
  lines: 0,
  created: 0,
  skipped: 0,
  failed: 0,
  invalid: 0,
};

function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return { ...ZERO };
  try {
    return { ...ZERO, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ...ZERO };
  }
}

/** Write the checkpoint atomically so a crash can't truncate it. */
function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint));
  renameSync(tmp, path);
}

/** How much sidecar output to accumulate before appending it to disk. */
const SINK_FLUSH_BYTES = 4 * 1024 * 1024;

/**
 * Append-only line writer with a bounded in-memory buffer.
 *
 * Deliberately not a `node:fs` write stream. Under Bun those queue writes
 * internally and keep returning `true` from `write()`, so the usual
 * drain-based backpressure never engages and the queue is never felt.
 * Measured on this dump: the ingest loop reading and parsing 8M lines held
 * at 0.08 GB RSS, and the same loop with the deletion sidecar on a write
 * stream reached 10.3 GB. Batching into a fixed buffer and issuing a
 * synchronous append keeps the syscalls off the hot path — one per 4 MB —
 * while making it impossible for anything to accumulate unnoticed.
 */
class LineSink {
  private readonly fd: number;
  private buffer: string[] = [];
  private bytes = 0;

  constructor(path: string, append: boolean) {
    this.fd = openSync(path, append ? "a" : "w");
  }

  write(line: string): void {
    this.buffer.push(line);
    this.bytes += line.length + 1;
    if (this.bytes >= SINK_FLUSH_BYTES) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    writeSync(this.fd, `${this.buffer.join("\n")}\n`);
    this.buffer = [];
    this.bytes = 0;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

function rateStr(n: number, startedAt: number): string {
  const seconds = (Date.now() - startedAt) / 1000;
  return seconds > 0 ? `${Math.round(n / seconds)}/s` : "-";
}

// ---------------------------------------------------------------------------
// Phase 1: ingest
// ---------------------------------------------------------------------------

/** Attempts per batch before its events are counted as failed. */
const MAX_ATTEMPTS = 6;

/** Backoff before retry `n` (1-based), capped so a stall can't wedge the run. */
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

/**
 * Write one batch, retrying while the cluster pushes back.
 *
 * A busy production cluster answers a bulk request with 429s under load, and
 * an import that treated those as failures would quietly lose events over a
 * multi-hour run. Retrying is safe because ingest uses `create`: an event
 * written by an earlier attempt comes back as a skip, not a duplicate.
 *
 * A whole-request failure (connection reset, gateway timeout) is retried the
 * same way, for the same reason.
 */
async function writeBatch(
  relay: OpenSearchRelay,
  events: NostrEvent[],
  checkpoint: Checkpoint,
  log: Logger,
): Promise<void> {
  let outstanding = events;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Slots are reconciled in phase 2, once everything is searchable.
      const result = await relay.importEvents(outstanding, {
        resolveSlots: false,
      });

      checkpoint.created += result.created;
      checkpoint.skipped += result.skipped;
      checkpoint.failed += result.failed;
      if (result.errors.length > 0) {
        log.warn("import_batch_errors", { errors: result.errors.join("; ") });
      }

      outstanding = result.retryable;
      if (outstanding.length === 0) return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        checkpoint.failed += outstanding.length;
        log.error("import_batch_failed", {
          count: outstanding.length,
          err: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      log.warn("import_batch_retry", {
        attempt,
        count: outstanding.length,
        err: error instanceof Error ? error.message : String(error),
      });
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    }
  }

  // Still pushed back after every attempt.
  checkpoint.failed += outstanding.length;
  log.error("import_batch_exhausted", { count: outstanding.length });
}

/**
 * Stream the dump into the index, and set the later phases up.
 *
 * Events destined for phases 2 and 3 are written to sidecar files as they go
 * by, so neither phase has to decompress 100 GB again. Both sidecars record
 * every candidate rather than only the events this run actually wrote: bulk
 * writes are pooled, so at the point a line is recorded its outcome isn't
 * known yet. Recording too much is harmless — re-resolving a settled slot
 * takes the no-loser fast path, and re-applying a deletion re-marks a
 * document that is already `deleted: true` — whereas recording too little
 * would silently skip work. A kind 5 stored by an earlier interrupted run
 * needs replaying for the same reason.
 */
async function ingest(
  relay: OpenSearchRelay,
  opts: Options,
  paths: { checkpoint: string; slots: string; deletions: string },
  log: Logger,
): Promise<void> {
  const checkpoint = opts.resume
    ? loadCheckpoint(paths.checkpoint)
    : { ...ZERO };
  const resumeLines = checkpoint.lines;

  const slotsOut = new LineSink(paths.slots, opts.resume);
  const deletionsOut = new LineSink(paths.deletions, opts.resume);

  const reader = readLines(opts.file, checkpoint.offset);
  const { lines, close } = reader;
  const pool = new Pool(opts.concurrency);

  // A seekable reader resumed at the checkpoint's byte offset, so every line
  // it yields is new. Only the .zst path has to re-read and discard.
  const skipLines = reader.seekable ? 0 : resumeLines;

  if (resumeLines > 0) {
    log.info("import_resume", {
      lines: resumeLines,
      offset: checkpoint.offset,
      mode: reader.seekable ? "seek" : "rescan",
    });
  }

  let batch: NostrEvent[] = [];
  // Continues the resumed count when seeking; the rescan path recounts from
  // zero and discards everything up to `skipLines`.
  let read = reader.seekable ? resumeLines : 0;
  let processed = 0;
  const startedAt = Date.now();

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const events = batch;
    batch = [];

    if (opts.dryRun) {
      checkpoint.created += events.length;
      return;
    }

    await pool.run(() => writeBatch(relay, events, checkpoint, log));
  };

  for await (const line of lines) {
    read++;
    if (read <= skipLines) continue;
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      checkpoint.invalid++;
      continue;
    }

    if (!isWellFormed(parsed)) {
      checkpoint.invalid++;
      continue;
    }

    const event = parsed;

    if (opts.verifyIds && !hasValidId(event)) {
      checkpoint.invalid++;
      log.warn("import_bad_id", { id: event.id });
      continue;
    }

    // Ephemeral events are never stored (NIP-01), so importing them would
    // create documents the relay itself would refuse to write.
    if (NKinds.ephemeral(event.kind)) continue;

    if (isDeletionRequest(event)) {
      deletionsOut.write(line);
    }

    batch.push(event);
    processed++;

    if (batch.length >= opts.batch) {
      const slotted = batch.filter(isSlotted);
      await flush();
      // Recorded after the flush so the sidecar only names events this run
      // actually tried to write.
      for (const event of slotted) {
        slotsOut.write(JSON.stringify(trimToSlot(event)));
      }

      // Get the sidecars onto disk before the checkpoint claims these lines
      // are done, or a crash would advance past work phases 2 and 3 never
      // learn about.
      slotsOut.flush();
      deletionsOut.flush();

      checkpoint.lines = read;
      checkpoint.offset = reader.position();
      saveCheckpoint(paths.checkpoint, checkpoint);

      if (processed % (opts.batch * 100) === 0) {
        const mem = process.memoryUsage();
        log.info("import_progress", {
          lines: read,
          created: checkpoint.created,
          skipped: checkpoint.skipped,
          failed: checkpoint.failed,
          invalid: checkpoint.invalid,
          rate: rateStr(processed, startedAt),
          rss_mb: Math.round(mem.rss / 1048576),
          heap_mb: Math.round(mem.heapUsed / 1048576),
          external_mb: Math.round(mem.external / 1048576),
        });
      }
    }

    if (opts.limit > 0 && processed >= opts.limit) break;
  }

  const slotted = batch.filter(isSlotted);
  await flush();
  for (const event of slotted) {
    slotsOut.write(JSON.stringify(trimToSlot(event)));
  }
  await pool.drain();

  checkpoint.lines = read;
  checkpoint.offset = reader.position();
  saveCheckpoint(paths.checkpoint, checkpoint);

  close();
  slotsOut.close();
  deletionsOut.close();

  log.info("import_ingest_done", {
    lines: read,
    created: checkpoint.created,
    skipped: checkpoint.skipped,
    failed: checkpoint.failed,
    invalid: checkpoint.invalid,
    duration_s: Math.round((Date.now() - startedAt) / 1000),
  });
}

// ---------------------------------------------------------------------------
// Phase 2: replaceable slot resolution
// ---------------------------------------------------------------------------

/**
 * Reconcile every replaceable/addressable slot the import touched.
 *
 * The sidecar holds one line per slotted event written, which for an 18-month
 * dump means many versions of the same slot. Only the newest version of each
 * needs resolving — `resolveSlotsFor` marks every other visible version in
 * that slot `replaced: true` regardless of which one triggered it — so the
 * file is collapsed to one event per slot first. That turns millions of
 * events into a much smaller number of slots, and one msearch covers a whole
 * batch of them.
 */
async function resolveSlots(
  relay: OpenSearchRelay,
  opts: Options,
  slotsPath: string,
  log: Logger,
): Promise<void> {
  if (!existsSync(slotsPath)) {
    log.info("import_slots_skipped", { reason: "no sidecar file" });
    return;
  }

  const keyedPath = `${slotsPath}.keyed`;
  const sortedPath = `${slotsPath}.sorted`;

  // Step 1: project each record to a sortable, tab-delimited row. The slot
  // key is JSON-quoted so a `d` tag containing a tab or newline can't split
  // a row, and for the same reason the tags travel as JSON.
  log.info("import_slots_projecting", {});
  {
    const sink = new LineSink(keyedPath, false);
    const { lines, close } = readLines(slotsPath);
    for await (const line of lines) {
      if (!line) continue;
      let event: NostrEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      sink.write(
        [
          JSON.stringify(slotKey(event)),
          event.created_at,
          event.id,
          event.kind,
          event.pubkey,
          JSON.stringify(event.tags),
        ].join("\t"),
      );
    }
    close();
    sink.close();
  }

  // Step 2: sort by slot, then NIP-01 winner order within it — newest first,
  // lowest id breaking ties. `sort` spills to disk, so an 11M-record sidecar
  // costs bounded memory; deduplicating it in a Map does not, and that is
  // what OOM-killed this phase on the first attempt.
  log.info("import_slots_sorting", {});
  const sorter = bunSpawn(
    [
      "sort",
      "-t",
      "\t",
      "-k1,1",
      "-k2,2nr",
      "-k3,3",
      "-S",
      "1G",
      "--parallel=4",
      "-T",
      dirname(slotsPath),
      "-o",
      sortedPath,
      keyedPath,
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const sortCode = await sorter.exited;
  if (sortCode !== 0) {
    throw new Error(`sort exited with ${sortCode}`);
  }
  rmSync(keyedPath, { force: true });

  // Step 3: the first row of each slot is its winner, and resolving that one
  // marks every other visible version in the slot replaced.
  log.info("import_slots_start", {});

  if (opts.dryRun) return;

  // Ingest wrote with refresh: false. Without this, the msearch that picks
  // each slot's winner can't see the versions just imported.
  await relay.refreshIndex();

  const BATCH = 100;
  const startedAt = Date.now();
  let currentKey: string | null = null;
  let slots = 0;
  let batch: SlotEvent[] = [];

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const chunk = batch;
    batch = [];
    try {
      await relay.resolveSlotsFor(chunk);
    } catch (error) {
      log.error("import_slots_batch_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    }
    slots += chunk.length;
    if (slots % (BATCH * 100) === 0) {
      log.info("import_slots_progress", {
        slots,
        rate: rateStr(slots, startedAt),
      });
    }
  };

  const { lines, close } = readLines(sortedPath);
  for await (const row of lines) {
    if (!row) continue;
    const parts = row.split("\t");
    if (parts.length < 6) continue;

    const [key, createdAt, id, kind, pubkey, tagsJson] = parts;
    // Rows are grouped by slot and ordered winner-first, so every row after
    // the first in a group is a version the winner will replace anyway.
    if (key === currentKey) continue;
    currentKey = key;

    let tags: string[][];
    try {
      tags = JSON.parse(tagsJson);
    } catch {
      continue;
    }

    batch.push({
      id,
      kind: Number(kind),
      pubkey,
      created_at: Number(createdAt),
      tags,
    });

    if (batch.length >= BATCH) await flushBatch();
  }
  await flushBatch();
  close();
  rmSync(sortedPath, { force: true });

  log.info("import_slots_done", {
    slots,
    duration_s: Math.round((Date.now() - startedAt) / 1000),
  });
}

// ---------------------------------------------------------------------------
// Phase 3: deletion requests
// ---------------------------------------------------------------------------

/** Max e-tag targets resolved in one lookup query. */
const DELETION_LOOKUP_SIZE = 1000;

/** Coordinates resolved to ids per msearch in the `a`-tag pass. */
const COORD_BATCH = 100;

/** Versions of one coordinate a single pass will mark. */
const COORD_VERSION_CAP = 100;

/** Run `sort` over a file, replacing it with the sorted result. */
async function externalSort(
  input: string,
  output: string,
  keys: string[],
  tmpDir: string,
): Promise<void> {
  const sorter = bunSpawn(
    [
      "sort",
      "-t",
      "\t",
      ...keys,
      "-S",
      "1G",
      "--parallel=4",
      "-T",
      tmpDir,
      "-o",
      output,
      input,
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const code = await sorter.exited;
  if (code !== 0) throw new Error(`sort exited with ${code}`);
}

/**
 * Replay the dump's deletion requests.
 *
 * Applying each request the way the live relay does — a query for its
 * targets, then an `updateByQuery` with a forced refresh — costs two round
 * trips per request, which is untenable for the tens of millions of kind 5
 * events in a Ditto dump. Both tag forms are instead flattened into sorted
 * files and resolved in batches:
 *
 * - `e` tags name ids directly. Sorting them groups every request that
 *   named a given target, so authorization runs once per (target, deleter)
 *   pair and a whole batch of authorized ids is marked in one bulk update.
 * - `a` tags name a coordinate and a cutoff. Sorting by coordinate and
 *   keeping the largest cutoff collapses them — 3.2M references became 2.7M
 *   distinct coordinates on the Ditto dump — and the survivors are resolved
 *   to ids {@link COORD_BATCH} at a time through one msearch, then marked
 *   the same way. Per-coordinate `updateByQuery` would have been days.
 *
 * Authorization is unchanged: `canDelete` decides every `e` tag, and only
 * coordinates the requester authored produce a filter at all.
 */
async function applyDeletions(
  relay: OpenSearchRelay,
  opts: Options,
  deletionsPath: string,
  relayUrl: string,
  log: Logger,
): Promise<void> {
  if (!existsSync(deletionsPath)) {
    log.info("import_deletions_skipped", { reason: "no sidecar file" });
    return;
  }

  const tmpDir = dirname(deletionsPath);
  const ePath = `${deletionsPath}.etags`;
  const aPath = `${deletionsPath}.atags`;
  const eSorted = `${ePath}.sorted`;
  const aSorted = `${aPath}.sorted`;

  // --- Pass 1: flatten requests into per-tag rows, and apply vanishes.
  log.info("import_deletions_flattening", {});
  let requests = 0;
  let vanished = 0;
  {
    const eOut = new LineSink(ePath, false);
    const aOut = new LineSink(aPath, false);
    const { lines, close } = readLines(deletionsPath);

    for await (const line of lines) {
      if (!line) continue;
      let event: NostrEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      requests++;

      if (event.kind === 62) {
        // NIP-62: only act when this relay is named (or ALL_RELAYS). Vanish
        // requests are rare enough to apply one at a time.
        const targeted = event.tags.some(
          (tag) =>
            tag[0] === "relay" &&
            tag.length >= 2 &&
            (tag[1] === "ALL_RELAYS" ||
              tag[1] === relayUrl ||
              tag[1] === relayUrl.replace(/\/$/, "")),
        );
        if (targeted && !opts.dryRun) {
          try {
            await applyVanishRequest(relay, event);
            vanished++;
          } catch (error) {
            log.error("import_vanish_failed", {
              id: event.id,
              err: error instanceof Error ? error.message : String(error),
            });
          }
        }
        continue;
      }

      for (const id of eTagTargets(event)) {
        eOut.write(`${id}\t${event.pubkey}`);
      }
      // Only coordinates the requester authored survive this.
      for (const filter of authorizedATagFilters(event)) {
        const dTag = filter["#d"]?.[0] ?? "";
        aOut.write(
          `${JSON.stringify(`${filter.kinds?.[0]}:${event.pubkey}:${dTag}`)}\t${event.created_at}`,
        );
      }

      if (requests % 1_000_000 === 0) {
        log.info("import_deletions_flatten_progress", { requests });
      }
    }
    close();
    eOut.close();
    aOut.close();
  }

  if (opts.dryRun) {
    log.info("import_deletions_done", { requests, deleted: 0, vanished });
    return;
  }

  // A deletion request can only be applied to targets the lookup can see,
  // and ingest wrote with refresh: false.
  await relay.refreshIndex();

  const startedAt = Date.now();
  let deleted = 0;

  // --- Pass 2: e-tag targets, grouped by id so each is authorized once.
  log.info("import_deletions_sorting", { which: "etags" });
  await externalSort(ePath, eSorted, ["-k1,1", "-k2,2", "-u"], tmpDir);
  rmSync(ePath, { force: true });

  log.info("import_deletions_etags_start", {});
  {
    /** target id -> the pubkeys that asked for its deletion. */
    let pending = new Map<string, string[]>();

    const flushPending = async (): Promise<void> => {
      if (pending.size === 0) return;
      const batch = pending;
      pending = new Map();

      let targets: NostrEvent[];
      try {
        targets = await relay.query([
          { ids: [...batch.keys()], limit: batch.size },
        ]);
      } catch (error) {
        log.error("import_deletions_lookup_failed", {
          ids: batch.size,
          err: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const authorized: string[] = [];
      for (const target of targets) {
        const deleters = batch.get(target.id);
        if (!deleters) continue;
        // The same event may be named by several requests, only some of
        // them entitled to it.
        if (deleters.some((pubkey) => canDelete(pubkey, target))) {
          authorized.push(target.id);
        }
      }

      if (authorized.length === 0) return;
      try {
        deleted += await relay.markDeletedByIds(authorized);
      } catch (error) {
        log.error("import_deletions_mark_failed", {
          count: authorized.length,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const { lines, close } = readLines(eSorted);
    for await (const row of lines) {
      if (!row) continue;
      const tab = row.indexOf("\t");
      if (tab === -1) continue;
      const id = row.slice(0, tab);
      const pubkey = row.slice(tab + 1);

      const deleters = pending.get(id);
      if (deleters) {
        deleters.push(pubkey);
      } else {
        pending.set(id, [pubkey]);
        if (pending.size >= DELETION_LOOKUP_SIZE) await flushPending();
      }
    }
    await flushPending();
    close();
    rmSync(eSorted, { force: true });
  }

  log.info("import_deletions_etags_done", {
    deleted,
    duration_s: Math.round((Date.now() - startedAt) / 1000),
  });

  // --- Pass 3: a-tag coordinates, collapsed to the largest cutoff each.
  log.info("import_deletions_sorting", { which: "atags" });
  await externalSort(aPath, aSorted, ["-k1,1", "-k2,2nr"], tmpDir);
  rmSync(aPath, { force: true });

  log.info("import_deletions_atags_start", {});
  {
    let currentKey: string | null = null;
    let coords = 0;
    let batch: Filter[] = [];

    const flushCoords = async (): Promise<void> => {
      if (batch.length === 0) return;
      const chunk = batch;
      batch = [];
      try {
        const idsPerFilter = await relay.queryIdsBatch(chunk, {
          size: COORD_VERSION_CAP,
        });
        const ids = idsPerFilter.flat();
        if (ids.length > 0) deleted += await relay.markDeletedByIds(ids);
      } catch (error) {
        log.error("import_deletions_coord_failed", {
          count: chunk.length,
          err: error instanceof Error ? error.message : String(error),
        });
      }
      coords += chunk.length;
      if (coords % (COORD_BATCH * 100) === 0) {
        log.info("import_deletions_atags_progress", {
          coords,
          deleted,
          rate: rateStr(coords, startedAt),
        });
      }
    };

    const { lines, close } = readLines(aSorted);
    for await (const row of lines) {
      if (!row) continue;
      const tab = row.indexOf("\t");
      if (tab === -1) continue;
      const key = row.slice(0, tab);
      // Rows are grouped by coordinate, largest cutoff first; the largest
      // subsumes every other deletion of the same coordinate.
      if (key === currentKey) continue;
      currentKey = key;

      const until = Number(row.slice(tab + 1));
      let coord: string;
      try {
        coord = JSON.parse(key);
      } catch {
        continue;
      }
      const parts = coord.split(":");
      if (parts.length < 3) continue;
      const kind = Number(parts[0]);
      const pubkey = parts[1];
      const dTag = parts.slice(2).join(":");
      if (!Number.isFinite(kind) || !Number.isFinite(until)) continue;

      const filter: Filter = {
        kinds: [kind],
        authors: [pubkey],
        until,
      };
      if (dTag) filter["#d"] = [dTag];
      batch.push(filter);

      if (batch.length >= COORD_BATCH) await flushCoords();
    }
    await flushCoords();
    close();
    rmSync(aSorted, { force: true });

    log.info("import_deletions_atags_done", { coords, deleted });
  }

  log.info("import_deletions_done", {
    requests,
    deleted,
    vanished,
    duration_s: Math.round((Date.now() - startedAt) / 1000),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.file)) {
    console.error(`No such file: ${opts.file}`);
    process.exit(1);
  }

  const config = new Config({
    get(key: string) {
      if (key === "OPENSEARCH_INDEX" && opts.index) return opts.index;
      return process.env[key];
    },
  });

  const log = new Logger(config.logLevel);
  const relay = OpenSearchRelay.fromConfig(config);

  if (!existsSync(opts.workDir)) mkdirSync(opts.workDir, { recursive: true });

  const stem = join(opts.workDir, basename(opts.file).replace(/\.zst$/, ""));
  const paths = {
    checkpoint: `${stem}.checkpoint.json`,
    slots: `${stem}.slots.jsonl`,
    deletions: `${stem}.deletions.jsonl`,
  };

  log.info("import_start", {
    file: opts.file,
    index: config.opensearchIndex,
    phase: opts.phase,
    batch: opts.batch,
    concurrency: opts.concurrency,
    verify_ids: opts.verifyIds,
    dry_run: opts.dryRun,
  });

  const startedAt = Date.now();

  if (opts.phase === "all" || opts.phase === "ingest") {
    await ingest(relay, opts, paths, log);
  }
  if (opts.phase === "all" || opts.phase === "slots") {
    await resolveSlots(relay, opts, paths.slots, log);
  }
  if (opts.phase === "all" || opts.phase === "deletions") {
    await applyDeletions(relay, opts, paths.deletions, config.relayUrl, log);
  }

  log.info("import_done", {
    duration_s: Math.round((Date.now() - startedAt) / 1000),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
