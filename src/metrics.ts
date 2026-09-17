/**
 * Lightweight Prometheus metrics — drop-in replacement for prom-client.
 *
 * prom-client's `inc()` and `observe()` do expensive label-object hashing on
 * every call (~7% CPU in profiles).  This module provides the same Counter,
 * Gauge, and Histogram API with near-zero per-call overhead by using simple
 * string-keyed Maps.
 *
 * The `register` singleton serialises metrics in the Prometheus exposition
 * format expected by `/metrics`.
 */

import process from "node:process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a labels object `{ verb: "REQ" }` to a stable string key. */
function labelKey(labels: Record<string, string | number>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  if (keys.length === 1) return `${keys[0]}="${labels[keys[0]]}"`;
  keys.sort();
  return keys.map((k) => `${k}="${labels[k]}"`).join(",");
}

/** Format a labels key as Prometheus label string: `{verb="REQ"}` */
function fmtLabels(key: string): string {
  return key ? `{${key}}` : "";
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

interface CounterOpts {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(opts: CounterOpts) {
    this.name = opts.name;
    this.help = opts.help;
    register._register(this);
  }

  inc(
    labelsOrValue?: Record<string, string | number> | number,
    value?: number,
  ): void {
    if (typeof labelsOrValue === "number" || labelsOrValue === undefined) {
      const key = "";
      this.values.set(key, (this.values.get(key) ?? 0) + (labelsOrValue ?? 1));
    } else {
      const key = labelKey(labelsOrValue);
      this.values.set(key, (this.values.get(key) ?? 0) + (value ?? 1));
    }
  }

  /** Serialize to Prometheus exposition format lines. */
  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${fmtLabels(key)} ${val}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

interface GaugeOpts {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(opts: GaugeOpts) {
    this.name = opts.name;
    this.help = opts.help;
    register._register(this);
  }

  set(
    labelsOrValue?: Record<string, string | number> | number,
    value?: number,
  ): void {
    if (typeof labelsOrValue === "number") {
      this.values.set("", labelsOrValue);
    } else if (
      labelsOrValue !== undefined &&
      typeof labelsOrValue === "object"
    ) {
      const key = labelKey(labelsOrValue);
      this.values.set(key, value ?? 0);
    }
  }

  inc(
    labelsOrValue?: Record<string, string | number> | number,
    value?: number,
  ): void {
    if (typeof labelsOrValue === "number" || labelsOrValue === undefined) {
      const key = "";
      this.values.set(key, (this.values.get(key) ?? 0) + (labelsOrValue ?? 1));
    } else {
      const key = labelKey(labelsOrValue);
      this.values.set(key, (this.values.get(key) ?? 0) + (value ?? 1));
    }
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${fmtLabels(key)} ${val}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

interface HistogramOpts {
  name: string;
  help: string;
  labelNames?: readonly string[];
  buckets?: number[];
}

const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

interface HistogramData {
  buckets: number[]; // counts per bucket boundary
  sum: number;
  count: number;
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly boundaries: number[];
  private data = new Map<string, HistogramData>();

  constructor(opts: HistogramOpts) {
    this.name = opts.name;
    this.help = opts.help;
    this.boundaries = opts.buckets ?? DEFAULT_BUCKETS;
    register._register(this);
  }

  private getOrCreate(key: string): HistogramData {
    let d = this.data.get(key);
    if (!d) {
      d = {
        buckets: new Array(this.boundaries.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.data.set(key, d);
    }
    return d;
  }

  observe(
    labelsOrValue: Record<string, string | number> | number,
    value?: number,
  ): void {
    let key: string;
    let v: number;
    if (typeof labelsOrValue === "number") {
      key = "";
      v = labelsOrValue;
    } else {
      if (value === undefined) {
        throw new TypeError("observe(labels, value) requires a value");
      }
      key = labelKey(labelsOrValue);
      v = value;
    }
    const d = this.getOrCreate(key);
    d.sum += v;
    d.count++;
    // Increment only the first matching bucket (non-cumulative storage).
    // The serialize step accumulates them into cumulative counts.
    for (let i = 0; i < this.boundaries.length; i++) {
      if (v <= this.boundaries[i]) {
        d.buckets[i]++;
        break;
      }
    }
  }

  /** Returns a function that, when called, observes the elapsed time in seconds. */
  startTimer(labels?: Record<string, string | number>): () => void {
    const start = performance.now();
    return () => {
      const elapsed = (performance.now() - start) / 1000;
      if (labels) {
        this.observe(labels, elapsed);
      } else {
        this.observe(elapsed);
      }
    };
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);
    for (const [key, d] of this.data) {
      const lblPrefix = key ? `{${key},` : "{";
      const lblSuffix = "}";
      let cumulative = 0;
      for (let i = 0; i < this.boundaries.length; i++) {
        cumulative += d.buckets[i];
        lines.push(
          `${this.name}_bucket${lblPrefix}le="${this.boundaries[i]}"${lblSuffix} ${cumulative}`,
        );
      }
      lines.push(
        `${this.name}_bucket${lblPrefix}le="+Inf"${lblSuffix} ${d.count}`,
      );
      lines.push(`${this.name}_sum${fmtLabels(key)} ${d.sum}`);
      lines.push(`${this.name}_count${fmtLabels(key)} ${d.count}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

class Registry {
  private collectors: Array<{ serialize(): string }> = [];

  readonly contentType = "text/plain; version=0.0.4; charset=utf-8";

  _register(collector: { serialize(): string }): void {
    this.collectors.push(collector);
  }

  async metrics(): Promise<string> {
    return `${this.collectors.map((c) => c.serialize()).join("\n\n")}\n`;
  }
}

export const register = new Registry();

// ---------------------------------------------------------------------------
// Multi-thread exposition merging
// ---------------------------------------------------------------------------

/**
 * Inject a `worker="<label>"` label into one exposition sample line.
 * Handles both `name value` and `name{labels} value` forms; our Registry
 * never emits empty `{}` label sets.
 */
function injectWorkerLabel(sample: string, label: string): string {
  const brace = sample.indexOf("{");
  const space = sample.indexOf(" ");
  if (brace !== -1 && brace < space) {
    return `${sample.slice(0, brace + 1)}worker="${label}",${sample.slice(brace + 1)}`;
  }
  return `${sample.slice(0, space)}{worker="${label}"}${sample.slice(space)}`;
}

/**
 * Merge Prometheus exposition texts from multiple threads into one valid
 * document. Each thread has its own metric registry, so the same metric
 * name appears in several sources; Prometheus requires all samples of a
 * metric to be grouped under a single HELP/TYPE header. Samples get a
 * `worker="<label>"` label identifying the originating thread, so totals
 * are a `sum without (worker) (...)` away.
 *
 * Only supports the block format produced by this module's Registry
 * (blank-line-separated blocks of `# HELP` / `# TYPE` / samples).
 */
export function mergeExposition(
  sources: Array<{ label: string; text: string }>,
): string {
  interface Block {
    help: string;
    type: string;
    samples: string[];
  }
  const blocks = new Map<string, Block>();

  for (const { label, text } of sources) {
    for (const rawBlock of text.split("\n\n")) {
      let help = "";
      let type = "";
      let name = "";
      const samples: string[] = [];
      for (const line of rawBlock.split("\n")) {
        if (line.length === 0) continue;
        if (line.startsWith("# HELP ")) {
          help = line;
          name = line.split(" ")[2] ?? "";
        } else if (line.startsWith("# TYPE ")) {
          type = line;
        } else {
          samples.push(injectWorkerLabel(line, label));
        }
      }
      if (!name) continue;
      const existing = blocks.get(name);
      if (existing) {
        existing.samples.push(...samples);
      } else {
        blocks.set(name, { help, type, samples });
      }
    }
  }

  const out: string[] = [];
  for (const block of blocks.values()) {
    out.push([block.help, block.type, ...block.samples].join("\n"));
  }
  return `${out.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Relay metrics
// ---------------------------------------------------------------------------

/** Total Nostr messages processed by relay, labeled by verb (EVENT, REQ, COUNT, AUTH, CLOSE). */
export const relayMessagesCounter = new Counter({
  name: "ditto_relay_messages_total",
  help: "Total Nostr messages processed by relay",
  labelNames: ["verb"] as const,
});

/** Total EVENT messages processed by relay, labeled by kind. */
export const relayEventsCounter = new Counter({
  name: "ditto_relay_events_total",
  help: "Total EVENT messages processed by relay",
  labelNames: ["kind"] as const,
});

/** Active relay WebSocket connections. */
export const relayConnectionsGauge = new Gauge({
  name: "ditto_relay_connections",
  help: "Active relay connections",
});

/**
 * Events scored by the nspam classifier, split by whether the score met
 * `SPAM_THRESHOLD`. Only reply-shaped kinds are scored (1 and 1111), so this
 * counts a subset of `ditto_relay_events_total`.
 */
export const relaySpamClassifiedCounter = new Counter({
  name: "ditto_relay_spam_classified_total",
  help: "Replies (kind 1/1111) scored by the nspam classifier",
  labelNames: ["spam"] as const,
});

/**
 * Distribution of raw nspam scores.
 *
 * The model is bimodal — most notes land hard against 0 or 1 — so the
 * buckets are clustered at the ends where the threshold actually sits rather
 * than spread evenly.
 */
export const relaySpamScoreHistogram = new Histogram({
  name: "ditto_relay_spam_score",
  help: "Raw nspam score of scored replies",
  buckets: [0.001, 0.01, 0.1, 0.5, 0.9, 0.99, 0.999],
});

/** Active NIP-77 Negentropy sync sessions across all connections. */
export const relayNegentropySessionsGauge = new Gauge({
  name: "ditto_relay_negentropy_sessions",
  help: "Active NIP-77 Negentropy sync sessions",
});

// ---------------------------------------------------------------------------
// OpenSearch metrics
// ---------------------------------------------------------------------------

/** Total events indexed into OpenSearch, labeled by kind. */
export const opensearchEventsCounter = new Counter({
  name: "ditto_opensearch_events_total",
  help: "Total events indexed into OpenSearch",
  labelNames: ["kind"] as const,
});

/** Total OpenSearch queries executed, labeled by type (req, sort, count, slot_resolution, slot_cleanup_history, slot_cleanup_delete, slot_cleanup_deep, aggregation). */
export const opensearchQueriesCounter = new Counter({
  name: "ditto_opensearch_queries_total",
  help: "Total OpenSearch queries executed",
  labelNames: ["type"] as const,
});

/**
 * Count of Phase 2 slots that had deep history visible at msearch time
 * (i.e. msearch returned `size: 2` worth of hits, indicating ≥1 prior
 * version may be older than the one we saw). Under healthy operation this
 * should be near zero; sustained nonzero values mean prior cleanup ops
 * have been failing and stragglers are accumulating in slots.
 */
export const opensearchSlotDeepHistoryCounter = new Counter({
  name: "ditto_opensearch_slot_deep_history_total",
  help: "Phase 2 slots where msearch hit its size limit, indicating possible stragglers",
});

/**
 * Count of Phase 2 tasks dropped because the waiter queue exceeded its
 * cap. Dropped tasks are safe (the next replacement event for any
 * affected slot will resolve it), but a nonzero value indicates ingest
 * is sustainedly outrunning Phase 2 capacity.
 */
export const opensearchPhase2DroppedCounter = new Counter({
  name: "ditto_opensearch_phase2_dropped_total",
  help: "Phase 2 tasks dropped due to waiter-queue overflow",
});

/**
 * Count of stale replaceable/addressable versions dropped from query
 * results because more than one `replaced: false` document was live in the
 * same slot, labeled by kind.
 *
 * A low background rate is expected — Phase 2 runs a refresh cycle behind
 * the write, so a slot legitimately holds two live versions for that
 * window. A sustained or growing rate means Phase 2 is not converging and
 * duplicates are accumulating in the index.
 */
export const opensearchSlotDuplicatesCounter = new Counter({
  name: "ditto_opensearch_slot_duplicates_total",
  help: "Stale replaceable/addressable versions dropped from query results",
  labelNames: ["kind"] as const,
});

/** Duration of OpenSearch queries in seconds, labeled by type. */
export const opensearchQueryDurationHistogram = new Histogram({
  name: "ditto_opensearch_query_duration_seconds",
  help: "Duration of OpenSearch queries in seconds",
  labelNames: ["type"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/** Current size of the OpenSearch bulk indexing queue. */
export const opensearchBulkQueueGauge = new Gauge({
  name: "ditto_opensearch_bulk_queue_size",
  help: "Current size of the OpenSearch bulk indexing queue",
});

/** Duration of OpenSearch bulk flush operations in seconds. */
export const opensearchFlushDurationHistogram = new Histogram({
  name: "ditto_opensearch_flush_duration_seconds",
  help: "Duration of OpenSearch bulk flush operations in seconds",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/** Duration of individual OpenSearch search HTTP calls in seconds. */
export const opensearchSearchDurationHistogram = new Histogram({
  name: "ditto_opensearch_search_duration_seconds",
  help: "Duration of OpenSearch search HTTP calls in seconds",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/** Duration of REQ handling in seconds (from message parse to EOSE sent). */
export const relayReqDurationHistogram = new Histogram({
  name: "ditto_relay_req_duration_seconds",
  help: "Duration of REQ handling from message parse to EOSE sent",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/**
 * Number of stored events returned per REQ (before EOSE). Each returned
 * event costs a JSON.stringify + ws.send on the main thread, so this
 * histogram is the direct measure of REQ serialization load.
 */
export const reqEventsReturnedHistogram = new Histogram({
  name: "ditto_relay_req_events_returned",
  help: "Number of stored events returned per REQ",
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

// ---------------------------------------------------------------------------
// Relay broadcast metrics
// ---------------------------------------------------------------------------

/** Current size of the broadcast queue. */
export const relayBroadcastQueueGauge = new Gauge({
  name: "ditto_relay_broadcast_queue_size",
  help: "Current size of the relay broadcast queue",
});

// ---------------------------------------------------------------------------
// Overload / backpressure
// ---------------------------------------------------------------------------

/**
 * Count of EVENT messages rejected because the relay was overloaded
 * (OpenSearch bulk queue cap exceeded).
 */
export const relayOverloadCounter = new Counter({
  name: "ditto_relay_overload_total",
  help: "EVENT messages rejected due to backpressure",
  labelNames: ["source"] as const, // "storage"
});

// ---------------------------------------------------------------------------
// Runtime health (event loop / memory)
// ---------------------------------------------------------------------------

/**
 * Event loop scheduling delay in seconds, sampled every 5 seconds. Bun's
 * event loop is single-threaded, so sustained lag here means every
 * websocket message, REQ, and /metrics scrape is queueing behind it.
 */
export const eventLoopLagGauge = new Gauge({
  name: "ditto_event_loop_lag_seconds",
  help: "Event loop scheduling delay beyond the timer interval, sampled every 5s",
});

/** Resident set size of the relay process in bytes. */
export const processRssGauge = new Gauge({
  name: "ditto_process_rss_bytes",
  help: "Resident set size of the relay process",
});

/** JavaScript heap used by the relay process in bytes. */
export const jsHeapUsedGauge = new Gauge({
  name: "ditto_js_heap_used_bytes",
  help: "JavaScript heap used by the relay process",
});

/**
 * Number of virtual memory areas (mappings) held by the process.
 *
 * This is a hard wall, not a soft one: at `vm.max_map_count` every mmap and
 * mprotect that would split a VMA fails with ENOMEM, and JSC's collector
 * spins retrying them. The process pins every core, stops serving, and
 * never recovers. JSC decommits heap blocks with madvise, which splits
 * adjacent same-permission mappings that the kernel then cannot merge, so
 * the count grows with allocation churn rather than with live heap — RSS
 * looks fine right up until the wall. All protocol workers share one
 * address space and therefore one budget, so the count scales with
 * PROTOCOL_WORKERS.
 *
 * Alert on `ditto_process_vma_count / ditto_process_vma_limit > 0.7`.
 */
export const processVmaCountGauge = new Gauge({
  name: "ditto_process_vma_count",
  help: "Virtual memory areas mapped by the relay process",
});

/** The kernel's `vm.max_map_count` — the ceiling for the gauge above. */
export const processVmaLimitGauge = new Gauge({
  name: "ditto_process_vma_limit",
  help: "Kernel vm.max_map_count limit on virtual memory areas",
});

/**
 * Times `process.memoryUsage()` threw and the sample was dropped. Non-zero
 * means the RSS and heap gauges have gaps; it does not mean the relay is
 * unhealthy.
 */
export const memorySampleFailures = new Counter({
  name: "ditto_memory_sample_failures_total",
  help: "Runtime memory samples skipped because process.memoryUsage() threw",
});

/**
 * Count lines in /proc/self/maps by streaming it.
 *
 * Deliberately not `readFileSync`: this file is ~50 bytes per mapping, so a
 * process about to hit the limit produces a 25 MB read. Materialising that
 * as a string to `split("\n")` would add megabytes of garbage to a heap
 * that is already the problem being measured.
 */
async function readVmaCount(): Promise<number | undefined> {
  try {
    const { createReadStream } = await import("node:fs");
    return await new Promise<number>((resolve, reject) => {
      let lines = 0;
      // No encoding set, so chunks arrive as Buffers — which are
      // Uint8Arrays, countable bytewise without decoding to a string.
      const stream = createReadStream("/proc/self/maps");
      stream.on("data", (chunk: Uint8Array | string) => {
        if (typeof chunk === "string") return; // unreachable without encoding
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === 0x0a) lines++;
        }
      });
      stream.on("end", () => resolve(lines));
      stream.on("error", reject);
    });
  } catch {
    return undefined; // not Linux, or /proc not mounted
  }
}

/** Read `vm.max_map_count`, or undefined where /proc is unavailable. */
async function readVmaLimit(): Promise<number | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("/proc/sys/vm/max_map_count", "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start sampling runtime health metrics. The lag gauge measures how much
 * later than scheduled each tick fires — a direct signal of event-loop
 * saturation on whatever thread this runs on. Returns a function that
 * stops sampling.
 *
 * @param opts.memory Sample RSS/heap/VMA count too. Only the main thread
 *   should do this: `process.memoryUsage()` and /proc/self are
 *   process-wide, so per-worker samples would just duplicate the same
 *   number under every worker label.
 */
export function startRuntimeMetrics(
  intervalMs = 5_000,
  opts?: { memory?: boolean },
): () => void {
  const memory = opts?.memory ?? true;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    eventLoopLagGauge.set(Math.max(0, (now - expected) / 1000));
    expected = now + intervalMs;

    if (memory) {
      // process.memoryUsage() can throw (Bun raises SystemError "Failed to
      // get memory usage" on this host). An unhandled throw in a timer
      // callback is an uncaught exception and takes the whole relay down,
      // which is an absurd way to lose a server: the sample is
      // observability, not load-bearing. Skip it and take the next one.
      try {
        const mem = process.memoryUsage();
        processRssGauge.set(mem.rss);
        jsHeapUsedGauge.set(mem.heapUsed);
      } catch {
        memorySampleFailures.inc();
      }
    }
  }, intervalMs);
  timer.unref?.();

  if (!memory) {
    return () => clearInterval(timer);
  }

  // Sampled on its own slower timer: /proc/self/maps is O(mappings) to
  // read, and the reader gets most expensive exactly when the process is
  // in trouble. 30s is ample for a number that took 13 days to climb.
  let vmaInFlight = false;
  const vmaTimer = setInterval(() => {
    if (vmaInFlight) return;
    vmaInFlight = true;
    readVmaCount()
      .then((count) => {
        if (count !== undefined) processVmaCountGauge.set(count);
      })
      .catch(() => {})
      .finally(() => {
        vmaInFlight = false;
      });
  }, 30_000);
  vmaTimer.unref?.();

  // The limit is a boot-time constant; read it once.
  readVmaLimit()
    .then((limit) => {
      if (limit !== undefined) processVmaLimitGauge.set(limit);
    })
    .catch(() => {});

  return () => {
    clearInterval(timer);
    clearInterval(vmaTimer);
  };
}
