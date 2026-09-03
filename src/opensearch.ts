import type { NostrEvent, NostrFilter, NStore } from "@nostrify/nostrify";
import { NIP50, NKinds } from "@nostrify/nostrify";
import { buildAutocompleteText } from "./autocomplete-text.ts";
import type { Config } from "./config.ts";
import { StorageOverloaded } from "./errors.ts";
import { isExpired } from "./expiration.ts";
import { clip, errFields, Logger } from "./log.ts";
import { detectMedia } from "./media.ts";
import {
  opensearchBulkQueueGauge,
  opensearchEventsCounter,
  opensearchFlushDurationHistogram,
  opensearchPhase2DroppedCounter,
  opensearchQueriesCounter,
  opensearchQueryDurationHistogram,
  opensearchSlotDeepHistoryCounter,
  opensearchSlotDuplicatesCounter,
} from "./metrics.ts";
import { DEFAULT_NSFW_HASHTAGS, detectNsfw } from "./nsfw.ts";
import type {
  ClientOptions,
  MsearchResponseItem,
  SearchResponseBody,
} from "./opensearch-client.ts";
import {
  type Client,
  Client as OpenSearchClient,
} from "./opensearch-client.ts";
import { getPow } from "./pow.ts";
import { buildSearchText } from "./search-text.ts";

/** The 7 core Nostr event fields — used as `_source` filter so OpenSearch
 *  only returns these fields in read queries, reducing JSON response size
 *  and parse overhead. */
const NOSTR_EVENT_FIELDS = [
  "id",
  "pubkey",
  "created_at",
  "kind",
  "tags",
  "content",
  "sig",
] as const;

/**
 * The score fields maintained by {@link OpenSearchRelay.recomputeScores}.
 *
 * Single source of truth: the zeroing document, the equivalent painless
 * script and the per-event score record are all derived from this list, so
 * adding a score field can't leave one of them stale.
 */
const SCORE_FIELDS = [
  "followers",
  "engagers",
  "comment_cnt",
  "reaction_cnt",
  "repost_cnt",
  "quote_cnt",
  "zap_amount_msats",
  "zap_cnt",
] as const;

type ScoreField = (typeof SCORE_FIELDS)[number];

/** Score fields that only apply to kind 0 profiles (computed in Phase 2a). */
const PROFILE_SCORE_FIELDS = [
  "followers",
] as const satisfies readonly ScoreField[];

/** Score fields that only apply to non-kind-0 events (computed in Phase 2b). */
const ENGAGEMENT_SCORE_FIELDS = SCORE_FIELDS.filter(
  (f): f is Exclude<ScoreField, "followers"> => f !== "followers",
);

/** All score fields set to zero. */
type Scores = Record<ScoreField, number>;

/** A fresh {@link Scores} with every field at zero. */
function zeroScores(): Scores {
  return Object.fromEntries(SCORE_FIELDS.map((f) => [f, 0])) as Scores;
}

/**
 * Partial document applied to losers during Phase 2 history-preserving
 * cleanup. Marks the doc as replaced and zeroes its score fields so it
 * doesn't contribute to engagement aggregations. Frozen because it's
 * shared by reference across every bulk update.
 */
const REPLACED_DOC: Readonly<Record<string, unknown>> = Object.freeze({
  replaced: true,
  ...zeroScores(),
});

/**
 * The painless equivalent of {@link REPLACED_DOC}, for the update_by_query
 * deep-history sweep that can't send a partial document.
 */
const REPLACED_PAINLESS = [
  "ctx._source.replaced = true;",
  ...SCORE_FIELDS.map((f) => `ctx._source.${f} = 0;`),
].join("\n");

/**
 * The per-event engagement sub-queries issued by `recomputeScores()` Phase
 * 2b, in msearch order. Each counts referencing events of some kinds that
 * point at the target via `tags_map.<tag>`; `agg` adds an aggregation whose
 * value is read instead of (or alongside) the hit count.
 *
 * Kept as a table because all six differ only in these three fields, and
 * the readout below indexes into the responses by the same order.
 */
const ENGAGEMENT_QUERIES = [
  /** 0: comments */
  { field: "comment_cnt", kinds: [1, 1111], tag: "e" },
  /** 1: reactions */
  { field: "reaction_cnt", kinds: [7], tag: "e" },
  /** 2: reposts */
  { field: "repost_cnt", kinds: [6, 16], tag: "e" },
  /** 3: zaps — Lightning (9735) and onchain (8333); count plus amount sum */
  {
    field: "zap_cnt",
    kinds: [9735, 8333],
    tag: "e",
    agg: {
      name: "total_msats",
      body: { sum: { field: "amount_msats" } },
      into: "zap_amount_msats",
    },
  },
  /** 4: quotes — kind 1 referencing via a `q` tag */
  { field: "quote_cnt", kinds: [1], tag: "q" },
  /** 5: unique engagers — cardinality, so no hit count is read */
  {
    field: undefined,
    kinds: [1, 6, 7, 16, 1111, 9735, 8333],
    tag: "e",
    agg: {
      name: "unique_authors",
      body: { cardinality: { field: "pubkey" } },
      into: "engagers",
    },
  },
] as const satisfies ReadonlyArray<{
  field?: ScoreField;
  kinds: readonly number[];
  tag: "e" | "q";
  agg?: { name: string; body: unknown; into: ScoreField };
}>;

/**
 * Time window for decay-based script_score sorts (sort:hot, sort:rising).
 *
 * The hot score halves every 24 hours, so after 7 days an event retains
 * less than 0.8% of its base score — effectively zero. Bounding
 * `created_at` lets OpenSearch skip script-scoring the vast majority of
 * the index. Without this bound, a single `sort:hot` request runs the
 * painless script on every matching document (tens of millions of docs),
 * and a handful of concurrent requests can pin every CPU core.
 */
const DECAY_SORT_WINDOW_SECONDS = 7 * 24 * 3600;

/**
 * Granularity of the NIP-40 expiration cutoff attached to every query by
 * `buildQuery`.
 *
 * `tags_map.expiration` is a keyword field (the `tags_map.*` dynamic
 * template) holding millions of distinct values, so a range over it is a
 * multi-term query: Lucene walks the terms dictionary and unions postings.
 * It classifies such queries as costly and caches them as full-segment
 * bitsets — which only pays off if the exact clause recurs. With a
 * per-second cutoff it never does, so every query paid for a bitset build
 * that was then discarded. Measured on the production index: ~12ms for a
 * top-100 kind-1 query without the clause, ~100-200ms with a fresh cutoff,
 * and ~13-19ms with a repeated one.
 *
 * Bucketing makes the clause identical for a whole minute, so one build
 * amortizes over thousands of queries. It widens the query's answer by at
 * most the events that expired since the bucket began, and
 * {@link OpenSearchRelay.hitsToEvents} drops those from the result, so
 * what a client sees is unchanged.
 */
const EXPIRATION_BUCKET_SECONDS = 60;

/**
 * Provides the current set of trusted pubkeys for engagement counting, or
 * `undefined` when trust filtering is inactive (no WoT configured, or the
 * first WoT computation hasn't completed). Consulted per recompute tick so
 * a refreshed set applies without re-wiring.
 */
export type TrustProvider = () => ReadonlySet<string> | undefined;

/**
 * Maximum unique engager pubkeys returned per engagement sub-query in
 * trusted (WoT) mode, where each sub-query returns a per-pubkey `terms`
 * agg instead of a hit count so the readout can drop untrusted authors.
 * Events with more unique engaging pubkeys than this are undercounted —
 * in practice only sybil swarms get near the cap, and undercounting a
 * swarm is the desired direction.
 */
const TRUSTED_PUBKEY_AGG_SIZE = 3000;

/**
 * Maximum sub-requests per `_msearch` call issued by `recomputeScores`.
 *
 * The engagement phase issues 6 sub-queries per dirty event; sending every
 * dirty event's sub-queries in one msearch is fine for the small batches
 * of steady-state operation, but a large dirty burst — the WoT seed
 * re-dirty of thousands of events, or an engagement flood — produces a
 * payload big enough to time out the whole call, and since the dirty set
 * is already drained that discards the entire batch. Chunking bounds each
 * call; responses are concatenated in request order so the positional
 * readout is unaffected. 600 ≈ 100 events per engagement msearch.
 */
const RECOMPUTE_MSEARCH_CHUNK = 600;

/**
 * Maximum non-kind-0 (engagement) events processed by a single
 * `recomputeScores` call. Each such event costs 6 aggregation sub-queries;
 * a large dirty burst — the WoT seed re-dirty of thousands of events, or an
 * engagement flood — would otherwise run them all in one tick, monopolizing
 * the every-5s loop for minutes (the `recomputeInFlight` guard skips
 * overlapping ticks) and saturating the OpenSearch search pool. Overflow
 * stays in the pending dirty set and is picked up by subsequent ticks, so
 * the work drains steadily instead of in one blocking spike.
 */
const MAX_RECOMPUTE_ENGAGEMENT_PER_TICK = 300;

/**
 * A bucket of the per-pubkey `terms` agg used in trusted mode. The
 * optional `total_msats` sub-agg is only present on the zap sub-query.
 */
interface PubkeyBucket {
  key: string;
  doc_count: number;
  total_msats?: { value?: number };
}

/**
 * OpenSearch document structure for Nostr events
 */
interface NostrEventDocument extends NostrEvent {
  tags_map: Record<string, string[]>;
  /** Indexed full-text search field, built per-kind from event content. */
  search_text: string;
  /**
   * Short, name-shaped surface indexed with the edge-ngram analyzer.
   * Populated for kinds that have a natural autocomplete field (profiles,
   * channels, titled events). Queried by NIP-50 `autocomplete:true`.
   */
  autocomplete_text?: string;
  deleted?: boolean;
  /** Whether this document is a historical version replaced by a newer event. */
  replaced?: boolean;
  protocol?: string;
  /**
   * NIP-89 client address from the third value of a `client` tag.
   * Format: `<kind>:<pubkey>:<d-tag>` (e.g. `31990:<pubkey>:ditto`).
   * Queried by NIP-50 `client:<address>`. Distinct from `tags_map.client`,
   * which holds the human-readable client name (the tag's second value).
   */
  client?: string;
  amount_msats?: number;
  language?: string;
  sentiment?: string;
  media: boolean;
  video: boolean;
  /**
   * NSFW classification: media attachment + an NSFW hashtag (see nsfw.ts).
   * Queried by the NIP-50 `nsfw:false` extension (excludes flagged events).
   */
  nsfw: boolean;
  /**
   * Raw nspam reply-spam score in [0, 1], set only on kind 1 replies and
   * kind 1111 comments (see nspam/index.ts). Discovery-shaped queries
   * exclude documents at or above
   * `SPAM_THRESHOLD` unless the NIP-50 `include:spam` token is given.
   *
   * Absent means "never scored" — a non-reply, an event indexed before the
   * feature existed, or an ingest with spam filtering disabled. A `range`
   * query does not match documents missing the field, so unscored events are
   * always returned. That is what lets the backfill run incrementally
   * without hiding anything in the meantime.
   */
  spam_score?: number;
  /**
   * NIP-13 proof-of-work difficulty: the number of leading zero bits in the
   * event `id`, clamped to any committed target in the `nonce` tag. Events
   * without a `nonce` tag are stored with `pow: 0`. Queried by the NIP-50
   * `pow:<n>` extension (matches events with difficulty >= n).
   */
  pow: number;
  /** Number of followers (kind 0 profiles). */
  followers: number;
  /** Count of unique authors who engaged with this event (non-kind-0). */
  engagers: number;
  /** Count of kind 1/1111 referencing events (excludes quote reposts). */
  comment_cnt: number;
  /** Count of kind 7 referencing events. */
  reaction_cnt: number;
  /** Count of kind 6/16 referencing events. */
  repost_cnt: number;
  /** Count of kind 1 quote reposts referencing via `q` tag. */
  quote_cnt: number;
  /**
   * Sum of amount_msats from kind 9735 Lightning zap receipts and kind 8333
   * onchain zap events referencing this event.
   */
  zap_amount_msats: number;
  /**
   * Count of kind 9735 Lightning zap receipts + kind 8333 onchain zap events
   * referencing this event.
   */
  zap_cnt: number;
}

/** Scores computed for a non-kind-0 event by {@link OpenSearchRelay.recomputeScores}. */
export interface EventScores {
  comment_cnt: number;
  reaction_cnt: number;
  repost_cnt: number;
  quote_cnt: number;
  zap_amount_msats: number;
  zap_cnt: number;
}

/** Result returned by {@link OpenSearchRelay.recomputeScores}. */
export interface RecomputeResult {
  /** Total number of dirty events processed. */
  count: number;
  /** Pubkey -> follower count for dirty kind 0 events. */
  userScores: Map<string, { followers: number }>;
  /** Event ID -> engagement scores for dirty non-kind-0 events. */
  eventScores: Map<string, EventScores>;
}

/**
 * The fields replaceable-slot resolution actually reads off an event.
 *
 * Narrower than {@link NostrEvent} so a bulk importer can hold one of these
 * per slot in memory — a 100 GB dump has millions — without carrying the
 * `content` and `sig` that dominate an event's size and that slot ordering
 * never looks at.
 */
export type SlotEvent = Pick<
  NostrEvent,
  "id" | "kind" | "pubkey" | "created_at" | "tags"
>;

/**
 * The only thing replaceable-slot resolution reads about a pending write:
 * the event itself. Declared separately from {@link BulkEntry} so the bulk
 * importer can reconcile slots without building throwaway documents for
 * events it has already written.
 */
interface SlotCandidate {
  event: SlotEvent;
}

/** Pending bulk operation for an event. */
interface BulkEntry extends SlotCandidate {
  /** Narrowed: a pending write always has the whole event, slots don't. */
  event: NostrEvent;
  doc: NostrEventDocument;
  docId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** How many distinct bulk errors {@link OpenSearchRelay.importEvents} keeps. */
const IMPORT_ERROR_SAMPLE_SIZE = 5;

/** Bulk item statuses worth retrying: the cluster is busy, not the data bad. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Outcome of one {@link OpenSearchRelay.importEvents} batch. */
export interface ImportResult {
  /** Events written to the index by this batch. */
  created: number;
  /** Events left alone because their id was already indexed. */
  skipped: number;
  /** Events OpenSearch rejected for a reason retrying won't fix. */
  failed: number;
  /**
   * Events rejected because the cluster pushed back (429/503 and friends).
   * Nothing is wrong with them and nothing was written, so the caller should
   * retry them rather than count them lost. Retrying is safe: `create` makes
   * the whole import idempotent.
   */
  retryable: NostrEvent[];
  /** Up to {@link IMPORT_ERROR_SAMPLE_SIZE} representative failures. */
  errors: string[];
}

/**
 * A `(created_at, id)` record returned by {@link OpenSearchRelay.queryItems}
 * for NIP-77 Negentropy set reconciliation.
 */
export interface SyncItem {
  created_at: number;
  /** Lowercase 64-char hex event ID. */
  id: string;
}

/**
 * The shape {@link OpenSearchRelay.buildQuery} always returns. Declared
 * concretely (rather than `Record<string, unknown>`) so callers that need to
 * append clauses can reach `bool.must` without casting.
 */
interface BoolQuery {
  bool: {
    must: Record<string, unknown>[];
    must_not?: Record<string, unknown>[];
  };
}

/**
 * OpenSearch-backed Nostr relay implementation
 * Handles event storage and querying with full-text search support (NIP-50)
 */
export class OpenSearchRelay implements NStore, AsyncDisposable {
  /** Client used for read operations (search, count). */
  private client: Client;
  /** Client used for write operations (bulk, updateByQuery, deleteByQuery). Defaults to `client`. */
  private writeClient: Client;
  private indexName: string;
  /** Structured logger, injected by the entry point. */
  private log: Logger;

  /** Whether to preserve historical versions of replaceable/addressable events. */
  private historyEnabled: boolean;
  /** When set, only these kinds preserve history (whitelist takes precedence over exclude). */
  private historyKindsWhitelist: Set<number> | undefined;
  /** Kinds excluded from history preservation (ignored when whitelist is set). */
  private historyKindsExcluded: Set<number>;

  /** Bulk indexing queue. */
  private bulkQueue: BulkEntry[] = [];
  private bulkTimer: ReturnType<typeof setTimeout> | null = null;
  private bulkMaxSize: number;
  private bulkFlushMs: number;

  /**
   * In-memory sets of event IDs and pubkeys that need score recomputation.
   * Accumulated by {@link collectDirtyReferences} during bulk flushes and
   * drained by {@link recomputeScores} which fetches and processes them
   * directly from OpenSearch.
   *
   * This avoids a race condition where a referencing event (e.g. a repost)
   * and the event it references arrive in the same bulk batch. Because the
   * bulk flush uses `refresh: false`, the target event may not yet be
   * searchable immediately after flushing. By deferring to
   * `recomputeScores` (which runs every 5 s), the documents are guaranteed
   * to have been through multiple natural refresh cycles.
   */
  private pendingDirtyIds = new Set<string>();
  private pendingDirtyPubkeys = new Set<string>();

  /**
   * Maximum size of each pending-dirty set. When a set is full, further
   * additions are silently dropped until the next drain. This bounds the
   * fan-out of score-recomputation work triggered by a single flood of
   * referencing events (kinds 1/6/7/16/17/1111/9735/8333), since each dirty ID
   * produces 6 msearches and each dirty pubkey produces 1 msearch in
   * {@link recomputeScores}.
   */
  static readonly MAX_PENDING_DIRTY = 100_000;

  /**
   * Maximum concurrent Phase 2 (replaceable slot resolution) tasks across
   * all in-flight flushes. Caps OpenSearch pressure from slot cleanup so
   * bursty replaceable-event ingest (e.g. Bluesky bridge profile floods)
   * cannot starve live REQ traffic. When the limit is reached, additional
   * Phase 2 tasks queue rather than fan out.
   */
  static readonly MAX_PHASE2_CONCURRENCY = 4;

  /**
   * Maximum number of Phase 2 tasks permitted to wait behind the
   * concurrency semaphore. When exceeded, the new task is **dropped**
   * (logged + counted) rather than queued. Dropping is safe: the next
   * replacement event for any affected slot will re-trigger cleanup via
   * its own Phase 2 task. The cap exists to prevent unbounded waiter
   * accumulation under sustained overload.
   */
  static readonly MAX_PHASE2_WAITERS = 64;

  /** Currently in-flight Phase 2 tasks (counted against MAX_PHASE2_CONCURRENCY). */
  private phase2InFlight = 0;

  /** Pending Phase 2 resolver queue (drained as in-flight slots free up). */
  private phase2Waiters: Array<() => void> = [];

  /** Whether we've already warned about a full dirty set this drain cycle. */
  private dirtyOverflowWarned = false;

  /**
   * Optional callback invoked when engagement events reference addressable
   * events via `a` tags. Called with the set of `a` tag values (event
   * addresses like `30023:pubkey:slug`) that need NIP-85 stats updates.
   */
  onDirtyAddrs?: (addrs: Set<string>) => void;

  /**
   * Optional callback invoked when engagement events reference external
   * identifiers via `i` tags. Called with the set of `i` tag values
   * (NIP-73 identifiers) that need NIP-85 stats updates.
   */
  onDirtyIdentifiers?: (identifiers: Set<string>) => void;

  /**
   * Optional web-of-trust provider consulted by {@link recomputeScores}.
   * When it returns a set, engagement sub-queries switch from raw counts
   * to per-pubkey aggregations and only trusted authors contribute to the
   * score fields. Assigned by the background worker after construction;
   * `undefined` (or a provider returning `undefined`) keeps the unfiltered
   * behavior. Kind 0 `followers` counts are NOT filtered — popular
   * profiles have follower counts far beyond any per-pubkey agg size, so
   * filtering them needs a different mechanism.
   */
  trustProvider?: TrustProvider;

  /**
   * Add event IDs to the pending dirty set for score recomputation.
   * Silently drops additions when {@link MAX_PENDING_DIRTY} is reached.
   * Used by the background worker to inject dirty state received from the
   * main thread via `postMessage`.
   */
  addDirtyIds(ids: Iterable<string>): void {
    for (const id of ids) this.addDirtyId(id);
  }

  /**
   * Add pubkeys to the pending dirty set for score recomputation.
   * Silently drops additions when {@link MAX_PENDING_DIRTY} is reached.
   * Used by the background worker to inject dirty state received from the
   * main thread via `postMessage`.
   */
  addDirtyPubkeys(pubkeys: Iterable<string>): void {
    for (const pk of pubkeys) this.addDirtyPubkey(pk);
  }

  /** Add one event ID, respecting the cap. Returns false once capped. */
  private addDirtyId(id: string): boolean {
    if (this.pendingDirtyIds.size >= OpenSearchRelay.MAX_PENDING_DIRTY) {
      this.warnDirtyOverflow("ids");
      return false;
    }
    this.pendingDirtyIds.add(id);
    return true;
  }

  /** Add one pubkey, respecting the cap. Returns false once capped. */
  private addDirtyPubkey(pubkey: string): boolean {
    if (this.pendingDirtyPubkeys.size >= OpenSearchRelay.MAX_PENDING_DIRTY) {
      this.warnDirtyOverflow("pubkeys");
      return false;
    }
    this.pendingDirtyPubkeys.add(pubkey);
    return true;
  }

  /** Log once per drain cycle when a dirty set hits the cap. */
  private warnDirtyOverflow(which: string): void {
    if (!this.dirtyOverflowWarned) {
      this.log.warn("dirty_overflow", {
        which,
        max: OpenSearchRelay.MAX_PENDING_DIRTY,
      });
      this.dirtyOverflowWarned = true;
    }
  }

  /**
   * Drain the pending dirty sets and return their contents.
   * Public wrapper around the internal drain, used by the main thread to
   * collect dirty state after flush and forward it to the background worker.
   */
  drainDirty(): { ids: string[]; pubkeys: string[] } {
    const { ids, pubkeys } = this.drainPendingDirty();
    return { ids: [...ids], pubkeys: [...pubkeys] };
  }

  /** Kinds excluded from queries that don't explicitly request them (e.g. DMs, gift wraps). */
  private authKinds: Set<number>;

  /** Delay in ms before Phase 2 (replaceable slot resolution) runs, giving
   *  the natural refresh_interval time to make just-indexed docs visible.
   *  Set to 0 in tests where the mock client resolves synchronously. */
  private refreshDelayMs: number;

  /** Per-instance override of TAG_VALUE_MAX_COUNT_PER_NAME. */
  private tagValueMaxCountPerName: number;

  /** Lowercase NSFW hashtag set used by the ingest fallback (see nsfw.ts). */
  private nsfwHashtags: ReadonlySet<string>;
  /** Raw nspam score at or above which documents are hidden; 0 = disabled. */
  private spamThreshold: number;

  /**
   * Maximum number of events permitted to sit in the bulk queue. When
   * exceeded, {@link event} rejects new events with {@link StorageOverloaded}
   * so the relay can NACK upstream clients instead of accumulating an
   * unbounded backlog under firehose ingest. Default: 5_000.
   */
  private bulkMaxQueue: number;

  constructor(
    client: Client,
    opts?: {
      indexName?: string;
      bulkMaxSize?: number;
      bulkFlushMs?: number;
      /**
       * Maximum number of events permitted to sit in the bulk queue before
       * {@link event} starts rejecting with {@link StorageOverloaded}.
       * Default: 5_000.
       */
      bulkMaxQueue?: number;
      historyEnabled?: boolean;
      historyKindsWhitelist?: Set<number>;
      historyKindsExcluded?: Set<number>;
      authKinds?: Set<number>;
      /** Separate client for write operations. When provided, write-heavy
       *  operations (bulk indexing, updateByQuery, deleteByQuery) use this
       *  client so their connection pool cannot starve read queries. */
      writeClient?: Client;
      /** Delay in ms before Phase 2 replaceable slot resolution. Defaults to
       *  1000 (one refresh_interval cycle). Set to 0 in tests. */
      refreshDelayMs?: number;
      /**
       * Override the per-tag-name value cap applied in
       * {@link buildTagsMap}. Defaults to
       * {@link TAG_VALUE_MAX_COUNT_PER_NAME} (5000).
       */
      tagValueMaxCountPerName?: number;
      /**
       * Lowercase NSFW hashtag set for the ingest-path fallback when no
       * pre-computed analysis is supplied (see nsfw.ts). Defaults to
       * {@link DEFAULT_NSFW_HASHTAGS}; entry points inject
       * `Config.nsfwHashtags`.
       */
      nsfwHashtags?: ReadonlySet<string>;
      /**
       * Raw nspam score at or above which a document is excluded from
       * discovery-shaped queries (see `Config.spamThreshold`). `0` disables
       * the exclusion entirely. Defaults to 0.
       */
      spamThreshold?: number;
      /**
       * Structured logger. Defaults to a fresh `info`-level Logger; entry
       * points inject one built from `Config.logLevel`.
       */
      logger?: Logger;
    },
  ) {
    this.client = client;
    this.log = opts?.logger ?? new Logger();
    this.writeClient = opts?.writeClient ?? client;
    this.indexName = opts?.indexName || "nostr-events";
    this.bulkMaxSize = opts?.bulkMaxSize ?? 100;
    this.bulkFlushMs = opts?.bulkFlushMs ?? 200;
    this.bulkMaxQueue = opts?.bulkMaxQueue ?? 5_000;
    this.historyEnabled = opts?.historyEnabled ?? true;
    this.historyKindsWhitelist = opts?.historyKindsWhitelist;
    this.historyKindsExcluded =
      opts?.historyKindsExcluded ?? new Set([30382, 30383, 30384, 30385]);
    this.authKinds = opts?.authKinds ?? new Set();
    this.refreshDelayMs = opts?.refreshDelayMs ?? 1_000;
    this.tagValueMaxCountPerName =
      opts?.tagValueMaxCountPerName ??
      OpenSearchRelay.TAG_VALUE_MAX_COUNT_PER_NAME;
    this.nsfwHashtags = opts?.nsfwHashtags ?? DEFAULT_NSFW_HASHTAGS;
    this.spamThreshold = opts?.spamThreshold ?? 0;
  }

  /**
   * Every constructor option derived from {@link Config}, in one place.
   *
   * Each entry point builds its own instance rather than calling
   * {@link fromConfig}, because they differ in *client* wiring: the protocol
   * workers are read-only, the indexer owns the write client, the background
   * worker holds both. Only the client half legitimately varies, so spreading
   * this keeps the config half from drifting between them.
   *
   * That drift is not hypothetical — the protocol workers once omitted
   * `spamThreshold` here while still passing it to the analyzer, so replies
   * were scored on ingest and the score was then never applied to any query.
   * A call site that needs different behavior should override a field
   * explicitly, so the deviation is visible.
   */
  static optionsFromConfig(config: Config): {
    indexName: string;
    historyEnabled: boolean;
    historyKindsWhitelist: Set<number> | undefined;
    historyKindsExcluded: Set<number> | undefined;
    authKinds: Set<number>;
    tagValueMaxCountPerName: number;
    nsfwHashtags: ReadonlySet<string>;
    spamThreshold: number;
  } {
    return {
      indexName: config.opensearchIndex,
      historyEnabled: config.historyEnabled,
      historyKindsWhitelist: config.historyKindsWhitelist,
      historyKindsExcluded: config.historyKindsExcluded,
      authKinds: config.authKinds,
      tagValueMaxCountPerName: config.tagValueMaxCountPerName,
      nsfwHashtags: config.nsfwHashtags,
      spamThreshold: config.spamThreshold,
    };
  }

  /**
   * Create OpenSearchRelay from config
   */
  static fromConfig(config: Config): OpenSearchRelay {
    const clientOptions: ClientOptions = {
      node: config.opensearchNode,
    };

    if (config.opensearchUsername && config.opensearchPassword) {
      clientOptions.auth = {
        username: config.opensearchUsername,
        password: config.opensearchPassword,
      };
    }

    const client = new OpenSearchClient(clientOptions);
    return new OpenSearchRelay(client, {
      ...OpenSearchRelay.optionsFromConfig(config),
      logger: new Logger(config.logLevel),
    });
  }

  /**
   * Single-character tag names are always indexable (any character).
   * This covers all standard single-letter tags (a-z, A-Z) and special
   * characters like `-` (NIP-70).
   */
  private static SINGLE_CHAR_TAG_RE = /^.$/;

  /**
   * Whitelist of multi-letter tag names whose values make sense as keyword
   * fields (exact-match, terms queries, or existence checks).
   *
   * Only tags whose values are identifiers, enum-like strings, or numeric
   * strings used in range queries are included. Free-form text (alt, title,
   * subject, summary, name, etc.), URLs (image, clone, streaming, relay,
   * etc.), and niche protocol-specific tags are excluded since keyword
   * fields treat the entire value as a single opaque token.
   */
  static readonly MULTI_LETTER_TAG_WHITELIST: ReadonlySet<string> = new Set([
    // NIP-40: unix timestamp string, used in range queries for event expiry
    "expiration",
    // NIP-75: event id hex, same referencing pattern as `e` tag
    "goal",
    // NIP-48: external ID, used for exists checks and protocol detection
    "proxy",
    // NIP-52, NIP-53, NIP-69: enum-like values (live/ended/pending/active/sold/etc)
    "status",
    // NIP-89: client application identifier
    "client",
    // NIP-36: sensitive content marker (value is an optional free-text
    // reason). Indexed for existence checks so clients can exclude
    // sensitive events with `-tag:content-warning`.
    "content-warning",
  ]);

  /** Maximum length of a single tag value stored in tags_map. */
  static readonly TAG_VALUE_MAX_LENGTH = 255;

  /**
   * Default maximum number of values stored per tag name in tags_map.
   * Overridable per-instance via the `tagValueMaxCountPerName` constructor
   * option (wired to the `RELAY_TAG_VALUE_MAX_COUNT_PER_NAME` env var).
   *
   * Tags beyond this limit are silently dropped during indexing. Prevents a
   * single event from inflating the per-document `tags_map` field and the
   * inverted index's term dictionary unboundedly.
   *
   * The default of 5000 accommodates legitimate high-cardinality cases such
   * as kind-3 contact lists with many `p` tags, preserving correctness of
   * follower counts, trending pubkeys, and NIP-85 kind 30382 stats.
   *
   * The raw `tags` array is still stored in full under the `tags` field
   * (which has `enabled: false` in the mapping), so NIP-01 protocol
   * correctness is preserved — only the searchable projection is clipped.
   */
  static readonly TAG_VALUE_MAX_COUNT_PER_NAME = 5000;

  /**
   * Hard ceiling on how many hits a single search may return, mirroring the
   * `index.max_result_window` setting applied at index creation. This is a
   * mechanical OpenSearch constraint, not relay policy: client-facing
   * `limit` defaults and caps (NIP-11 `limitation.max_limit`) are applied by
   * the relay before filters reach this class.
   */
  static readonly MAX_RESULT_WINDOW = 100000;

  /**
   * Check whether a tag name is indexable.
   *
   * - All single-character tag names are allowed (covers a-z, A-Z, `-`, etc.).
   * - Multi-character tag names must appear in the whitelist of NIP-defined
   *   tags whose values are useful to index.
   */
  static isIndexableTagName(tagName: string): boolean {
    return (
      OpenSearchRelay.SINGLE_CHAR_TAG_RE.test(tagName) ||
      OpenSearchRelay.MULTI_LETTER_TAG_WHITELIST.has(tagName)
    );
  }

  /**
   * Build tags_map from tags array.
   *
   * Validates tag names and values:
   * - Single-character tag names are always allowed.
   * - Multi-character tag names must be in the whitelist of NIP-defined tags.
   * - Marker tags with no value (e.g. NIP-70 `["-"]`, NIP-36
   *   `["content-warning"]`) are indexed with an empty-string value so
   *   `exists` queries (`tag:<name>` / `-tag:<name>`) still see them.
   * - Tag values must be ≤ 255 characters. Values that exceed the limit are
   *   skipped, but the tag name key is still created (with an empty array if
   *   no values pass).
   * - At most `tagValueMaxCountPerName` values are stored per tag name
   *   (default {@link TAG_VALUE_MAX_COUNT_PER_NAME}). Further values
   *   (in-order) are silently dropped. The raw `tags` array is still
   *   preserved under the disabled `tags` field, so the full event data is
   *   returned verbatim to query consumers.
   */
  private buildTagsMap(
    tags: string[][],
    kind: number,
  ): Record<string, string[]> {
    const tagsMap: Record<string, string[]> = {};

    for (const tag of tags) {
      if (tag.length >= 1) {
        const [tagName, value = ""] = tag;

        if (!OpenSearchRelay.isIndexableTagName(tagName)) {
          continue;
        }

        if (!tagsMap[tagName]) {
          tagsMap[tagName] = [];
        }

        if (
          value.length <= OpenSearchRelay.TAG_VALUE_MAX_LENGTH &&
          tagsMap[tagName].length < this.tagValueMaxCountPerName
        ) {
          tagsMap[tagName].push(value);
        }
      }
    }

    // NIP-25: For kind 7 reactions, the target event is the *last* e tag.
    // Only index the last value to avoid inflating stats for intermediate refs.
    // We reference the original `tags` array rather than the clipped tagsMap
    // because the last e tag might have been dropped above when the event has
    // more than `tagValueMaxCountPerName` e-tags.
    if (kind === 7 && tagsMap.e?.length) {
      for (let i = tags.length - 1; i >= 0; i--) {
        const t = tags[i];
        if (
          t.length >= 2 &&
          t[0] === "e" &&
          t[1].length <= OpenSearchRelay.TAG_VALUE_MAX_LENGTH
        ) {
          tagsMap.e = [t[1]];
          break;
        }
      }
    }

    return tagsMap;
  }

  /** Generate OpenSearch document ID for an event (the hex event ID). */
  private getDocumentId(event: NostrEvent): string {
    return event.id;
  }

  /**
   * Parse the amount in millisatoshis from a bolt11 invoice string.
   * Returns undefined if the invoice cannot be parsed.
   *
   * BOLT 11 encodes amounts in the human-readable prefix as `lnbc{number}{multiplier}`:
   * - `m` = milli-BTC (×100,000,000 msats)
   * - `u` = micro-BTC (×100,000 msats)
   * - `n` = nano-BTC  (×100 msats)
   * - `p` = pico-BTC  (×0.1 msats, must be multiple of 10)
   */
  static parseBolt11Amount(bolt11: string): number | undefined {
    const match = bolt11.match(/^lnbc(\d+)([munp])/);
    if (!match) return undefined;

    const num = Number.parseInt(match[1], 10);
    const multiplier = match[2];

    // 1 BTC = 10^8 sats = 10^11 msats
    // m (milli) = 10^-3 BTC = 10^5 sats = 10^8  msats
    // u (micro) = 10^-6 BTC = 10^2 sats = 10^5  msats
    // n (nano)  = 10^-9 BTC = 10^-1 sats = 10^2  msats
    // p (pico)  = 10^-12 BTC = 10^-4 sats = 10^-1 msats
    const msatsPerUnit: Record<string, number> = {
      m: 100_000_000,
      u: 100_000,
      n: 100,
      p: 0.1,
    };

    return Math.round(num * msatsPerUnit[multiplier]);
  }

  /**
   * Parse the amount in millisatoshis from a kind 8333 onchain zap event.
   * The `amount` tag on kind 8333 holds a decimal integer number of
   * **satoshis** (per the kind 8333 spec in Ditto's NIP.md). This helper
   * reads that tag and converts to msats for consistency with the
   * `amount_msats` field used for kind 9735 zap receipts.
   *
   * Returns undefined when the event has no valid `amount` tag.
   */
  static parseOnchainZapAmount(event: NostrEvent): number | undefined {
    const amountTag = event.tags.find((t) => t[0] === "amount" && t[1]);
    if (!amountTag) return undefined;

    // Per NIP.md kind 8333: "amount" is a decimal integer in sats.
    // Reject non-integer / negative / non-finite values.
    if (!/^\d+$/.test(amountTag[1])) return undefined;

    const sats = Number.parseInt(amountTag[1], 10);
    if (!Number.isFinite(sats) || sats < 0) return undefined;

    return sats * 1000;
  }

  /**
   * Detect media attachments for an event.
   * Delegates to the shared `detectMedia()` function in `media.ts`.
   */
  static detectMedia = detectMedia;

  /**
   * Convert NostrEvent to OpenSearch document.
   * When `analysis` is provided (from the worker pool), those pre-computed
   * values are used directly instead of detecting on the main thread.
   */
  private eventToDocument(
    event: NostrEvent,
    analysis?: {
      search_text?: string;
      autocomplete_text?: string;
      language?: string;
      sentiment?: string;
      media?: boolean;
      video?: boolean;
      nsfw?: boolean;
      spam_score?: number;
    },
  ): NostrEventDocument {
    const tagsMap = this.buildTagsMap(event.tags, event.kind);

    // Extract protocol from proxy tag (NIP-48)
    // Format: ["proxy", <id>, <protocol>]
    const proxyTag = event.tags.find(
      (tag) => tag[0] === "proxy" && tag.length >= 3,
    );
    const protocol = proxyTag?.[2];

    // Extract client address from the NIP-89 client tag (NIP-50 client:).
    // Format: ["client", <name>, <kind>:<pubkey>:<d-tag>, <relay>?]
    // The third value is the addressable handler coordinate; we index it as
    // a keyword distinct from tags_map.client (which holds the name).
    const clientTag = event.tags.find(
      (tag) => tag[0] === "client" && tag.length >= 3,
    );
    const client = clientTag?.[2];

    // Extract zap amount from bolt11 for kind 9735 (zap receipts),
    // or from the `amount` tag (sats) for kind 8333 (onchain zaps).
    let amount_msats: number | undefined;
    if (event.kind === 9735) {
      const bolt11Tag = event.tags.find((t) => t[0] === "bolt11" && t[1]);
      if (bolt11Tag) {
        amount_msats = OpenSearchRelay.parseBolt11Amount(bolt11Tag[1]);
      }
    } else if (event.kind === 8333) {
      amount_msats = OpenSearchRelay.parseOnchainZapAmount(event);
    }

    const language = analysis?.language;
    const sentiment = analysis?.sentiment;

    // Use pre-computed media detection from the analyze worker when available,
    // otherwise detect on the main thread (direct event() calls, eg tests).
    const mediaResult =
      analysis?.media !== undefined
        ? { media: analysis.media, video: analysis.video }
        : OpenSearchRelay.detectMedia(event);

    // NSFW rides on media detection: when the analyzer computed media it
    // also computed nsfw (absent = false); otherwise classify here using
    // the local media result.
    const nsfw =
      analysis?.media !== undefined
        ? (analysis.nsfw ?? false)
        : detectNsfw(event, mediaResult.media, this.nsfwHashtags);

    // Use pre-computed autocomplete text from the analyze worker when
    // available; otherwise build on the main thread (direct event() calls,
    // tests). Only set the field when non-empty so events with no
    // autocomplete surface don't pollute the index.
    const autocompleteText =
      analysis?.autocomplete_text ?? buildAutocompleteText(event);

    return {
      ...event,
      tags_map: tagsMap,
      search_text: analysis?.search_text ?? buildSearchText(event),
      ...(autocompleteText && { autocomplete_text: autocompleteText }),
      deleted: false,
      replaced: false,
      ...(protocol && { protocol }),
      ...(client && { client }),
      ...(amount_msats !== undefined && { amount_msats }),
      ...(language && { language }),
      ...(sentiment && { sentiment }),
      media: mediaResult.media ?? false,
      video: mediaResult.video ?? false,
      nsfw,
      // Only the analyzer produces this — there is no local fallback, since
      // the indexer holds no model. Omitted rather than defaulted, so an
      // unscored event is distinguishable from one scored as clean.
      ...(analysis?.spam_score !== undefined && {
        spam_score: analysis.spam_score,
      }),
      pow: getPow(event),
      followers: 0,
      engagers: 0,
      comment_cnt: 0,
      reaction_cnt: 0,
      repost_cnt: 0,
      quote_cnt: 0,
      zap_amount_msats: 0,
      zap_cnt: 0,
    };
  }

  /**
   * Whether spam-flagged documents should be hidden from this filter.
   *
   * Only *discovery*-shaped filters are cleaned up. A filter that names
   * `ids` or `authors` is asking for specific events or a specific person's
   * posts, and the caller is entitled to get them — hiding a reply from its
   * own author's timeline, or from a direct id lookup, would be surprising
   * and would break clients that fetch an event they just published.
   *
   * Everything else is filtered, including `#e` (thread views) and `#p`
   * (notifications). Those are the two places reply spam actually
   * concentrates, so exempting them would defeat the feature.
   *
   * The NIP-50 `include:spam` extension opts out per query.
   */
  private shouldExcludeSpam(filter: NostrFilter): boolean {
    if (this.spamThreshold <= 0) return false;
    if (filter.ids && filter.ids.length > 0) return false;
    if (filter.authors && filter.authors.length > 0) return false;
    if (filter.search) {
      for (const token of NIP50.parseInput(filter.search)) {
        if (
          typeof token === "object" &&
          token.key === "include" &&
          token.value === "spam"
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Check if the NIP-50 search string contains a distinct:author extension token.
   */
  private hasDistinctAuthor(filter: NostrFilter): boolean {
    if (!filter.search) return false;

    const tokens = NIP50.parseInput(filter.search);
    return tokens.some(
      (t) =>
        typeof t === "object" && t.key === "distinct" && t.value === "author",
    );
  }

  /**
   * The `collapse` clause implementing `distinct:author`, or undefined when
   * the filter doesn't ask for it.
   *
   * Collapsing is what makes `distinct:author` return a full `limit` worth
   * of results: OpenSearch keeps searching until it has `limit` distinct
   * pubkeys, whereas de-duplicating the response in JS can only ever shrink
   * an already-truncated page.
   *
   * Filters restricted to replaceable kinds are exempt — those already hold
   * at most one current event per author, so collapsing buys nothing.
   */
  private collapseClause(filter: NostrFilter): { field: "pubkey" } | undefined {
    if (!this.hasDistinctAuthor(filter)) return undefined;
    if (filter.kinds?.every((k) => NKinds.replaceable(k))) return undefined;
    return { field: "pubkey" };
  }

  /**
   * Parse NIP-50 sort mode from search tokens
   */
  private parseSortMode(
    filter: NostrFilter,
  ): "top" | "hot" | "controversial" | "rising" | "zaps" | null {
    if (!filter.search) return null;

    const tokens = NIP50.parseInput(filter.search);
    const sortTokens = tokens.filter(
      (t) =>
        typeof t === "object" &&
        t.key === "sort" &&
        ["top", "hot", "controversial", "rising", "zaps"].includes(t.value),
    );

    // Multiple sort tokens: ambiguous, so fall back to no sort. queryFilter
    // separately rejects the query outright — it counts *all* `sort:` tokens
    // whereas this only counts recognised ones, so the two disagree on input
    // like `sort:bogus sort:bogus`.
    if (sortTokens.length > 1) {
      return null;
    }

    if (sortTokens.length === 1) {
      const token = sortTokens[0];
      return typeof token === "object"
        ? (token.value as "top" | "hot" | "controversial" | "rising" | "zaps")
        : null;
    }

    // If no sort-suppressing extension tokens are provided, default to
    // sort:top. Most extension tokens (eg sort:new, language:en) prevent
    // this default, but `autocomplete` is exempt: account autocomplete
    // (`autocomplete:true`) still wants follower-ranked results, not raw
    // recency ordering.
    const hasSuppressingToken = tokens.some(
      (t) => typeof t === "object" && t.key !== "autocomplete",
    );
    if (!hasSuppressingToken) {
      return "top";
    }

    return null;
  }

  /**
   * Check whether the filter targets only kind 0 (profile metadata) events.
   * When true, sort queries use follower-count / author-based ranking
   * instead of engagement scores.
   */
  private isKind0OnlyFilter(filter: NostrFilter): boolean {
    return (
      Array.isArray(filter.kinds) &&
      filter.kinds.length === 1 &&
      filter.kinds[0] === 0
    );
  }

  /**
   * Detect whether a filter should include historical (replaced) versions.
   *
   * Returns true for:
   * 1. ID-based queries (`{ ids: [...] }`) — clients asking for specific
   *    event IDs should always get them, even if they are replaced.
   * 2. naddr-shaped filters — exactly 1 replaceable/addressable kind +
   *    exactly 1 author (+ optionally 1 `#d` for addressable kinds),
   *    representable as a single `naddr`.
   */
  private isHistoryFilter(filter: NostrFilter): boolean {
    // Any filter with explicit IDs should include replaced docs — the
    // client asked for a specific event by ID and should get it.
    if (filter.ids && filter.ids.length > 0) {
      return true;
    }

    if (
      !filter.kinds ||
      filter.kinds.length !== 1 ||
      !filter.authors ||
      filter.authors.length !== 1
    ) {
      return false;
    }

    const kind = filter.kinds[0];

    if (NKinds.replaceable(kind)) {
      return true;
    }

    if (NKinds.addressable(kind)) {
      const dValues = (filter as Record<string, unknown>)["#d"];
      return Array.isArray(dValues) && dValues.length === 1;
    }

    return false;
  }

  /**
   * The replaceable/addressable slot an event occupies, or `null` for
   * regular kinds, which have no slot.
   */
  private static slotKey(event: NostrEvent): string | null {
    if (NKinds.replaceable(event.kind)) {
      return `${event.kind}:${event.pubkey}`;
    }
    if (NKinds.addressable(event.kind)) {
      const dTag = event.tags.find(([name]) => name === "d")?.[1] ?? "";
      return `${event.kind}:${event.pubkey}:${dTag}`;
    }
    return null;
  }

  /**
   * Drop stale versions of replaceable/addressable events from a result
   * set, keeping one event per slot.
   *
   * The `replaced: true` flag that {@link buildQuery} filters on is set by
   * Phase 2 of {@link flush}, which is fire-and-forget: it runs a refresh
   * cycle behind the write, can fail transiently, and is dropped outright
   * under sustained load (see {@link opensearchPhase2DroppedCounter}). A
   * slot can therefore hold more than one `replaced: false` document, and
   * no query-side predicate can hide the extras. Collapsing them here is
   * what makes REQ results NIP-01-correct irrespective of write-side state.
   *
   * The winner is the newest `created_at`, ties broken by lowest `id`. The
   * comparison has to be explicit rather than "first hit wins": the query
   * sorts on `created_at` alone, and duplicated slots routinely hold
   * versions written within the same second.
   *
   * Exempt are filters that asked for history — `ids` and naddr-shaped,
   * per {@link isHistoryFilter} — and filters that cannot match a
   * replaceable or addressable kind at all.
   *
   * This only ever shrinks a page: a REQ for `limit` events may come back
   * with fewer. Nothing servable is lost (the dropped versions are stale by
   * definition, and paging with `until` still advances), but a client that
   * reads a short page as end-of-results will stop early.
   */
  private dedupeSlots(events: NostrEvent[], filter: NostrFilter): NostrEvent[] {
    if (this.isHistoryFilter(filter)) return events;
    if (
      filter.kinds &&
      !filter.kinds.some((k) => NKinds.replaceable(k) || NKinds.addressable(k))
    ) {
      return events;
    }

    const winners = new Map<string, NostrEvent>();
    let slotEvents = 0;

    for (const event of events) {
      const key = OpenSearchRelay.slotKey(event);
      if (!key) continue;
      slotEvents++;

      const current = winners.get(key);
      if (
        !current ||
        event.created_at > current.created_at ||
        (event.created_at === current.created_at && event.id < current.id)
      ) {
        winners.set(key, event);
      }
    }

    // Every slot in the page held exactly one version — the overwhelmingly
    // common case. Return the original array without reallocating.
    if (slotEvents === winners.size) return events;

    return events.filter((event) => {
      const key = OpenSearchRelay.slotKey(event);
      if (!key || winners.get(key) === event) return true;
      opensearchSlotDuplicatesCounter.inc({ kind: event.kind });
      return false;
    });
  }

  /**
   * Query events using precomputed engagement scores.
   *
   * Each sort mode uses the building-block score fields (followers,
   * engagers, comment_cnt, reaction_cnt, repost_cnt, zap_amount_msats) that
   * are maintained by the background recomputeScores() job. Filters
   * are applied directly in the query, so results are correct for any
   * filter narrowing (kinds, tags, full-text search, etc.).
   *
   * When the filter targets only kind 0 (profiles), sort queries rank by
   * `followers` instead of `engagers`, and the modes that don't apply to a
   * profile directly (controversial, rising, zaps) derive an author
   * ordering from a non-kind-0 query first.
   */
  private async querySortedEvents(
    filter: NostrFilter,
    sortMode: "top" | "hot" | "controversial" | "rising" | "zaps",
    limit: number,
  ): Promise<NostrEvent[]> {
    let events: NostrEvent[];

    if (this.isKind0OnlyFilter(filter)) {
      switch (sortMode) {
        case "top":
          events = await this.querySortByField(filter, "followers", limit);
          break;
        case "hot":
          events = await this.querySortByDecay(filter, "followers", limit);
          break;
        case "controversial":
          events = await this.querySortKind0ByAuthors(
            filter,
            limit,
            this.querySortControversial.bind(this),
          );
          break;
        case "rising":
          events = await this.querySortKind0ByAuthors(
            filter,
            limit,
            this.querySortRising.bind(this),
          );
          break;
        case "zaps":
          events = await this.querySortZapsKind0(filter, limit);
          break;
      }
    } else {
      switch (sortMode) {
        case "top":
          events = await this.querySortByField(filter, "engagers", limit);
          break;
        case "hot":
          events = await this.querySortByDecay(filter, "engagers", limit);
          break;
        case "controversial":
          events = await this.querySortControversial(filter, limit);
          break;
        case "rising":
          events = await this.querySortRising(filter, limit);
          break;
        case "zaps":
          events = await this.querySortByField(
            filter,
            "zap_amount_msats",
            limit,
          );
          break;
      }
    }

    return events.slice(0, limit);
  }

  /**
   * Extract hits from an OpenSearch response as NostrEvent[].
   *
   * Expired events (NIP-40) are dropped here, which is what makes the
   * bucketed cutoff in {@link buildQuery} safe: the query excludes
   * everything expired as of the start of the current bucket, and this
   * removes the stragglers that expired since. Filtering in memory over
   * at most `limit` events costs a tag scan each, against a keyword range
   * over millions of terms in OpenSearch.
   *
   * Every read path that returns events funnels through here and asks
   * OpenSearch to exclude expired events, so the default filters. The
   * paths that deliberately reach expired events — `remove` and
   * `queryIdsBatch`, which pass `includeExpired` to `buildQuery` — read
   * ids straight off the response instead and never arrive here; `opts`
   * mirrors `buildQuery` so a future one can opt out explicitly rather
   * than lose its hits to a filter it didn't know about.
   */
  private hitsToEvents(
    response: {
      body: SearchResponseBody<NostrEvent>;
    },
    opts?: { includeExpired?: boolean },
  ): NostrEvent[] {
    const events = response.body.hits.hits.flatMap((hit) =>
      hit._source !== undefined ? [hit._source] : [],
    );
    if (opts?.includeExpired) return events;
    const now = Math.floor(Date.now() / 1000);
    return events.filter((event) => !isExpired(event, now));
  }

  /**
   * Sort by a precomputed score field, descending, tie-broken by recency.
   *
   * Backs `sort:top` (engagers — unique authors who referenced the event),
   * `sort:zaps` (zap_amount_msats) and the kind-0 form of `sort:top`
   * (followers). The user's filter is applied directly in the query.
   */
  private async querySortByField(
    filter: NostrFilter,
    field: "engagers" | "zap_amount_msats" | "followers",
    limit: number,
  ): Promise<NostrEvent[]> {
    const collapse = this.collapseClause(filter);

    const response = await this.client.search<NostrEvent>({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: this.buildQuery(filter),
        sort: [
          { [field]: { order: "desc" as const } },
          { created_at: { order: "desc" as const } },
        ],
        size: limit,
        ...(collapse && { collapse }),
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Sort by a score field weighted by exponential time decay:
   * `score = field * 0.5^(age_in_hours / 24)`. Uses a script_score query so
   * OpenSearch computes and sorts server-side.
   *
   * Backs `sort:hot` (engagers) and its kind-0 form (followers).
   *
   * Filters `created_at >= now - DECAY_SORT_WINDOW_SECONDS` and `field > 0`
   * so the painless script only runs on documents that can actually score.
   * Without these bounds every matching document in the index (tens of
   * millions) is script-scored per request, which can pin every OpenSearch
   * CPU core.
   */
  private async querySortByDecay(
    filter: NostrFilter,
    field: "engagers" | "followers",
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const query = this.buildQuery(filter);
    const collapse = this.collapseClause(filter);
    query.bool.must.push(
      { range: { created_at: { gte: now - DECAY_SORT_WINDOW_SECONDS } } },
      { range: { [field]: { gt: 0 } } },
    );

    const response = await this.client.search<NostrEvent>({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: {
          script_score: {
            query,
            script: {
              source: `
                double score = doc['${field}'].value;
                double ageHours = (params.now - doc['created_at'].value) / 3600.0;
                return score * Math.pow(0.5, ageHours / 24.0);
              `,
              params: { now },
            },
          },
        },
        size: limit,
        ...(collapse && { collapse }),
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Query controversial events — high engagement with balanced comments
   * vs reactions. Score = min(comment_cnt, reaction_cnt) * sqrt(total).
   *
   * Filters `comment_cnt > 0` and `reaction_cnt > 0` (documents missing
   * either score exactly 0) so the script only scores the small subset of
   * documents with both kinds of engagement.
   */
  private async querySortControversial(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const query = this.buildQuery(filter);
    const collapse = this.collapseClause(filter);
    query.bool.must.push(
      { range: { comment_cnt: { gt: 0 } } },
      { range: { reaction_cnt: { gt: 0 } } },
    );

    const response = await this.client.search<NostrEvent>({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: {
          script_score: {
            query,
            script: {
              source: `
                double comments = doc['comment_cnt'].value;
                double reactions = doc['reaction_cnt'].value;
                double balanced = Math.min(comments, reactions);
                return balanced * Math.sqrt(comments + reactions);
              `,
            },
          },
        },
        size: limit,
        ...(collapse && { collapse }),
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Query rising events — gaining engagement quickly relative to age.
   * Score = (comment_cnt + reaction_cnt + repost_cnt + quote_cnt) / age_in_hours.
   * Uses all-time counts as the score basis.
   *
   * Filters `created_at >= now - DECAY_SORT_WINDOW_SECONDS` so the script
   * only scores recent documents — "rising" is inherently about recency,
   * and older events divide by a huge age anyway.
   */
  private async querySortRising(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const query = this.buildQuery(filter);
    const collapse = this.collapseClause(filter);
    query.bool.must.push({
      range: { created_at: { gte: now - DECAY_SORT_WINDOW_SECONDS } },
    });

    const response = await this.client.search<NostrEvent>({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: {
          script_score: {
            query,
            script: {
              source: `
                double total = doc['comment_cnt'].value + doc['reaction_cnt'].value + doc['repost_cnt'].value + doc['quote_cnt'].value;
                double ageHours = Math.max((params.now - doc['created_at'].value) / 3600.0, 0.1);
                return total / ageHours;
              `,
              params: { now },
            },
          },
        },
        size: limit,
        ...(collapse && { collapse }),
      },
    });

    return this.hitsToEvents(response);
  }

  // ---------------------------------------------------------------------------
  // Kind-0 (profile) sort methods
  //
  // When the filter targets only kind 0, sort queries use follower-count
  // (stored in `followers`) and author-based ranking.  For modes that don't
  // apply directly to profiles (controversial, rising, zaps) we perform a
  // two-step query: first find top events by the sort mode across all kinds,
  // then return the kind 0 events for those authors.
  // ---------------------------------------------------------------------------

  /**
   * Sort kind 0 events by the total zap amount received across all of
   * an author's events.  Uses a terms aggregation on pubkey with a sum
   * sub-aggregation on zap_amount_msats.
   */
  private async querySortZapsKind0(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    // Phase 1: Aggregate total zap_amount_msats per author across all events.
    opensearchQueriesCounter.inc({ type: "aggregation" });
    const aggEnd = opensearchQueryDurationHistogram.startTimer({
      type: "aggregation",
    });
    const aggResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { range: { zap_amount_msats: { gt: 0 } } },
            ],
          },
        },
        size: 0,
        aggs: {
          top_authors: {
            terms: {
              field: "pubkey",
              size: limit * 5,
              order: { total_zaps: "desc" as const },
            },
            aggs: {
              total_zaps: {
                sum: { field: "zap_amount_msats" },
              },
            },
          },
        },
      },
    });
    aggEnd();

    const buckets =
      (
        aggResponse.body.aggregations?.top_authors as unknown as {
          buckets?: Array<{
            key: string;
            total_zaps?: { value: number };
          }>;
        }
      )?.buckets || [];

    if (buckets.length === 0) return [];

    // Ordered list of pubkeys by total zaps
    const orderedPubkeys = buckets.map((b) => b.key);

    // Phase 2: Fetch kind 0 events for those pubkeys (with search text filter).
    return this.fetchKind0ForAuthors(filter, orderedPubkeys, limit);
  }

  /**
   * Generic two-step helper for kind-0 sort modes that derive author
   * ordering from a non-kind-0 sort query.
   *
   * 1. Runs the provided `sortFn` WITHOUT the kinds:[0] constraint to
   *    find top-scoring events across all kinds.
   * 2. Extracts unique author pubkeys in score order.
   * 3. Fetches kind 0 events for those pubkeys, preserving the order.
   */
  private async querySortKind0ByAuthors(
    filter: NostrFilter,
    limit: number,
    sortFn: (filter: NostrFilter, limit: number) => Promise<NostrEvent[]>,
  ): Promise<NostrEvent[]> {
    // Build a filter without the kinds constraint so we search across all kinds.
    const { kinds: _kinds, ...filterWithoutKinds } = filter;

    // Over-fetch to account for deduplication by pubkey.
    const overFetchLimit = limit * 5;
    const events = await sortFn(filterWithoutKinds, overFetchLimit);

    // Extract unique author pubkeys in score order.
    const orderedPubkeys: string[] = [];
    const seenPubkeys = new Set<string>();
    for (const event of events) {
      if (!seenPubkeys.has(event.pubkey)) {
        seenPubkeys.add(event.pubkey);
        orderedPubkeys.push(event.pubkey);
      }
    }

    if (orderedPubkeys.length === 0) return [];

    // Fetch kind 0 events for those pubkeys (with search text filter).
    return this.fetchKind0ForAuthors(filter, orderedPubkeys, limit);
  }

  /**
   * Fetch kind 0 events for an ordered list of author pubkeys.
   *
   * Applies search-text and other filter constraints from the original
   * filter (except kinds and authors, which are overridden).  Results
   * are returned in the same order as `orderedPubkeys`.
   */
  private async fetchKind0ForAuthors(
    filter: NostrFilter,
    orderedPubkeys: string[],
    limit: number,
  ): Promise<NostrEvent[]> {
    // Override kinds and authors on the filter.
    const kind0Filter: NostrFilter = {
      ...filter,
      kinds: [0],
      authors: orderedPubkeys,
    };

    const query = this.buildQuery(kind0Filter);

    const response = await this.client.search<NostrEvent>({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query,
        size: orderedPubkeys.length, // one kind 0 per pubkey at most
      },
    });

    const events = this.hitsToEvents(response);

    // Re-order events to match the original pubkey ordering.
    const eventByPubkey = new Map<string, NostrEvent>();
    for (const event of events) {
      eventByPubkey.set(event.pubkey, event);
    }

    const ordered: NostrEvent[] = [];
    for (const pubkey of orderedPubkeys) {
      const event = eventByPubkey.get(pubkey);
      if (event) {
        ordered.push(event);
        if (ordered.length >= limit) break;
      }
    }

    return ordered;
  }

  /**
   * Build OpenSearch query from Nostr filter.
   *
   * When `includeReplaced` is true, historical (replaced) versions of
   * replaceable/addressable events are included in results. By default
   * they are excluded.
   */
  private buildQuery(
    filter: NostrFilter,
    opts?: {
      includeReplaced?: boolean;
      includeAuthKinds?: boolean;
      includeExpired?: boolean;
      includeSpam?: boolean;
    },
  ): BoolQuery {
    const must: Record<string, unknown>[] = [
      { term: { deleted: false } }, // Always exclude deleted events
    ];
    const mustNot: Record<string, unknown>[] = [];

    // Exclude replaced (historical) versions unless explicitly requested.
    if (!opts?.includeReplaced) {
      mustNot.push({ term: { replaced: true } });
    }

    // NIP-40: Exclude expired events. Deletion opts out — an expired event is
    // still stored, and a vanish request must reach it.
    //
    // The cutoff is rounded down to EXPIRATION_BUCKET_SECONDS so the clause is
    // byte-identical across a whole bucket. See the constant for why that
    // matters; a per-second cutoff makes this the most expensive part of an
    // otherwise cheap query. This clause is therefore a coarse pre-filter —
    // `hitsToEvents` drops whatever expired since the bucket began.
    if (!opts?.includeExpired) {
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - (now % EXPIRATION_BUCKET_SECONDS);
      mustNot.push({
        range: { "tags_map.expiration": { lte: String(cutoff) } },
      });
    }

    // ID filter
    if (filter.ids && filter.ids.length > 0) {
      must.push({ terms: { id: filter.ids } });
    }

    // Author filter
    if (filter.authors && filter.authors.length > 0) {
      must.push({ terms: { pubkey: filter.authors } });
    }

    // Kind filter
    if (filter.kinds && filter.kinds.length > 0) {
      must.push({ terms: { kind: filter.kinds } });
    } else if (
      this.authKinds.size > 0 &&
      !opts?.includeAuthKinds &&
      !(filter.ids && filter.ids.length > 0)
    ) {
      // Exclude auth-protected kinds from queries that don't explicitly request them.
      // When specific IDs are requested, skip exclusion — the relay layer handles auth.
      // Master-authed connections pass `includeAuthKinds` to opt out entirely.
      mustNot.push({ terms: { kind: [...this.authKinds] } });
    }

    // Spam exclusion (nspam). Applied here rather than inside the
    // `filter.search` block below because it has to reach filters with no
    // search term at all — a bare `{kinds: [1]}` global feed is exactly the
    // shape this is meant to clean up.
    //
    // NIP-50 only asks relays to exclude spam from *search* results; applying
    // it to every discovery-shaped filter is a deliberate superset.
    if (!opts?.includeSpam && this.shouldExcludeSpam(filter)) {
      mustNot.push({ range: { spam_score: { gte: this.spamThreshold } } });
    }

    // Time range filters (clamp to safe range for OpenSearch long type)
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since)
        range.gte = Math.min(filter.since, Number.MAX_SAFE_INTEGER);
      if (filter.until)
        range.lte = Math.min(filter.until, Number.MAX_SAFE_INTEGER);
      must.push({ range: { created_at: range } });
    }

    // Tag filters using tags_map
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        must.push({ terms: { [`tags_map.${tagName}`]: values } });
      }
    }

    // Full-text search (NIP-50)
    if (filter.search) {
      const tokens = NIP50.parseInput(filter.search);
      const textTokens = tokens.filter((t) => typeof t === "string");

      // Split into positive and negative (prefixed with "-") search terms
      const positiveTerms = textTokens
        .filter((t) => !t.startsWith("-"))
        .join(" ");
      const negativeTerms = textTokens
        .filter((t) => t.startsWith("-"))
        .map((t) => t.slice(1))
        .filter((t) => t.length > 0);

      // Detect the NIP-50 `autocomplete:true|false` extension token.
      // Default: enabled for kind-0-only filters (account autocomplete is
      // the dominant use case), disabled for everything else. An explicit
      // `autocomplete:true` opts non-kind-0 filters in; `autocomplete:false`
      // opts kind-0 filters out and back into normal token search.
      const autocompleteToken = tokens.find(
        (t) => typeof t === "object" && t.key === "autocomplete",
      );
      const autocompleteOn =
        autocompleteToken && typeof autocompleteToken === "object"
          ? autocompleteToken.value === "true"
          : this.isKind0OnlyFilter(filter);

      if (positiveTerms.trim()) {
        if (autocompleteOn) {
          // Edge-ngram prefix matching against the dedicated autocomplete
          // field. Documents without `autocomplete_text` (e.g. kind 1) will
          // simply not match, which is the desired semantics.
          must.push({
            match: {
              autocomplete_text: {
                query: positiveTerms,
                operator: "and",
              },
            },
          });
        } else {
          must.push({
            multi_match: {
              query: positiveTerms,
              fields: ["search_text", "search_text.url"],
              operator: "and",
              type: "best_fields",
            },
          });
        }
      }

      // Add negative terms as must_not clauses
      for (const term of negativeTerms) {
        if (autocompleteOn) {
          mustNot.push({
            match: { autocomplete_text: term },
          });
        } else {
          mustNot.push({
            multi_match: {
              query: term,
              fields: ["search_text", "search_text.url"],
            },
          });
        }
      }

      // Handle protocol: extension (NIP-48 + NIP-50)
      const protocolToken = tokens.find(
        (t) => typeof t === "object" && t.key === "protocol",
      );
      if (protocolToken && typeof protocolToken === "object") {
        if (protocolToken.value === "nostr") {
          mustNot.push({ exists: { field: "protocol" } });
        } else {
          must.push({
            term: { protocol: protocolToken.value },
          });
        }
      }

      // Handle client: extension (NIP-50 + NIP-89)
      // Filters by the client address (third value of a client tag),
      // eg "client:31990:<pubkey>:ditto".
      const clientToken = tokens.find(
        (t) => typeof t === "object" && t.key === "client",
      );
      if (clientToken && typeof clientToken === "object") {
        must.push({
          term: { client: clientToken.value },
        });
      }

      // Handle language: extension (NIP-50)
      const languageToken = tokens.find(
        (t) => typeof t === "object" && t.key === "language",
      );
      if (languageToken && typeof languageToken === "object") {
        must.push({
          term: { language: languageToken.value },
        });
      }

      // Handle sentiment: extension (NIP-50)
      const sentimentToken = tokens.find(
        (t) => typeof t === "object" && t.key === "sentiment",
      );
      if (sentimentToken && typeof sentimentToken === "object") {
        must.push({
          term: { sentiment: sentimentToken.value },
        });
      }

      // Handle media: extension (NIP-50)
      const mediaToken = tokens.find(
        (t) => typeof t === "object" && t.key === "media",
      );
      if (mediaToken && typeof mediaToken === "object") {
        if (mediaToken.value === "true") {
          must.push({ term: { media: true } });
        } else if (mediaToken.value === "false") {
          mustNot.push({ term: { media: true } });
        }
      }

      // Handle video: extension (NIP-50)
      const videoToken = tokens.find(
        (t) => typeof t === "object" && t.key === "video",
      );
      if (videoToken && typeof videoToken === "object") {
        if (videoToken.value === "true") {
          must.push({ term: { video: true } });
        } else if (videoToken.value === "false") {
          mustNot.push({ term: { video: true } });
        }
      }

      // Handle nsfw: extension (NIP-50). Per the NIP, nsfw events are
      // included by default; `nsfw:false` excludes them. `nsfw:true`
      // restores the default (no clause) rather than meaning "only nsfw".
      const nsfwToken = tokens.find(
        (t) => typeof t === "object" && t.key === "nsfw",
      );
      if (
        nsfwToken &&
        typeof nsfwToken === "object" &&
        nsfwToken.value === "false"
      ) {
        mustNot.push({ term: { nsfw: true } });
      }

      // Handle pow: extension (NIP-50 + NIP-13).
      // `pow:<n>` matches events whose stored proof-of-work difficulty is
      // at least `n` leading zero bits. Events without a `nonce` tag are
      // stored with `pow: 0`, so they only match `pow:0`. A non-numeric
      // value is ignored (no clause added).
      const powToken = tokens.find(
        (t) => typeof t === "object" && t.key === "pow",
      );
      if (
        powToken &&
        typeof powToken === "object" &&
        /^\d+$/.test(powToken.value)
      ) {
        must.push({
          range: { pow: { gte: Number.parseInt(powToken.value, 10) } },
        });
      }

      // Handle tag:/-tag: extensions (NIP-50).
      // `tag:<name>` matches events that have at least one indexed value for
      // the given tag name; `-tag:<name>` matches events with no such tag.
      // Only tag names that are actually indexed in tags_map are meaningful —
      // non-indexable names (see isIndexableTagName) never produce a tags_map
      // field, so `tag:` on them matches nothing and `-tag:` matches everything.
      for (const token of tokens) {
        if (typeof token !== "object") continue;
        if (token.key !== "tag" && token.key !== "-tag") continue;
        if (!OpenSearchRelay.isIndexableTagName(token.value)) continue;

        const clause = { exists: { field: `tags_map.${token.value}` } };
        if (token.key === "tag") {
          must.push(clause);
        } else {
          mustNot.push(clause);
        }
      }
    }

    const bool: BoolQuery["bool"] = { must };
    if (mustNot.length > 0) {
      bool.must_not = mustNot;
    }
    return { bool };
  }

  /**
   * Query events from OpenSearch based on a single filter
   */
  private async queryFilter(
    filter: NostrFilter,
    _signal?: AbortSignal,
    includeAuthKinds?: boolean,
  ): Promise<NostrEvent[]> {
    // If limit is 0, skip the query (realtime-only subscription)
    if (filter.limit === 0) {
      return [];
    }

    // Honor the filter's `limit` verbatim, bounded only by the index's result
    // window. Client-facing defaults and caps are applied by the relay before
    // filters get here (see `clampLimit` in relay.ts).
    const limit = Math.min(
      filter.limit ?? OpenSearchRelay.MAX_RESULT_WINDOW,
      OpenSearchRelay.MAX_RESULT_WINDOW,
    );

    // Check if this is a sort query
    const sortMode = this.parseSortMode(filter);

    // Validate: multiple sort tokens return 0 events
    if (filter.search) {
      const tokens = NIP50.parseInput(filter.search);
      const sortTokenCount = tokens.filter(
        (t) => typeof t === "object" && t.key === "sort",
      ).length;
      if (sortTokenCount > 1) {
        return []; // Invalid query - multiple sort tokens
      }
    }

    if (sortMode) {
      opensearchQueriesCounter.inc({ type: "sort" });
      const sortEnd = opensearchQueryDurationHistogram.startTimer({
        type: "sort",
      });
      try {
        return this.dedupeSlots(
          await this.querySortedEvents(filter, sortMode, limit),
          filter,
        );
      } finally {
        sortEnd();
      }
    }

    // Auto-include historical versions for naddr-shaped filters.
    const includeReplaced = this.isHistoryFilter(filter);
    const query = this.buildQuery(filter, {
      includeReplaced,
      includeAuthKinds,
    });
    const collapse = this.collapseClause(filter);

    // Sort by created_at (newest first)
    const sort = [{ created_at: { order: "desc" as const } }];

    opensearchQueriesCounter.inc({ type: "req" });
    const queryEnd = opensearchQueryDurationHistogram.startTimer({
      type: "req",
    });
    try {
      const searchBody: Record<string, unknown> = {
        _source: NOSTR_EVENT_FIELDS,
        query,
        sort,
        size: limit,
        track_total_hits: false,
      };

      // Use OpenSearch field collapsing to return only 1 event per pubkey
      if (collapse) {
        searchBody.collapse = collapse;
      }

      const response = await this.client.search<NostrEvent>({
        index: this.indexName,
        body: searchBody,
      });

      return this.dedupeSlots(this.hitsToEvents(response), filter);
    } finally {
      queryEnd();
    }
  }

  /**
   * Enqueue an event for bulk indexing.
   * The returned promise resolves once the event has been flushed to OpenSearch.
   *
   * When `opts.analysis` is provided (pre-computed by the analyze worker pool),
   * language and sentiment values are used directly instead of being detected
   * on the main thread.
   *
   * Rejects with {@link StorageOverloaded} when the bulk queue is already at
   * {@link bulkMaxQueue} entries. This is the storage-side counterpart to the
   * analyze pool's backpressure: it prevents the queue from growing without
   * bound when OpenSearch can't keep up with ingest. The relay translates this
   * into an `OK false "error: relay overloaded"` response per NIP-01.
   */
  async event(
    event: NostrEvent,
    opts?: {
      signal?: AbortSignal;
      analysis?: {
        search_text?: string;
        autocomplete_text?: string;
        language?: string;
        sentiment?: string;
        media?: boolean;
        video?: boolean;
        nsfw?: boolean;
        spam_score?: number;
      };
    },
  ): Promise<void> {
    if (this.bulkQueue.length >= this.bulkMaxQueue) {
      throw new StorageOverloaded(this.bulkQueue.length, this.bulkMaxQueue);
    }

    const doc = this.eventToDocument(event, opts?.analysis);
    const docId = this.getDocumentId(event);

    return new Promise<void>((resolve, reject) => {
      this.bulkQueue.push({ event, doc, docId, resolve, reject });
      opensearchBulkQueueGauge.set(this.bulkQueue.length);

      if (this.bulkQueue.length >= this.bulkMaxSize) {
        this.flush();
      } else if (!this.bulkTimer) {
        this.bulkTimer = setTimeout(() => this.flush(), this.bulkFlushMs);
      }
    });
  }

  /**
   * Flush the bulk queue to OpenSearch.
   *
   * All events are indexed uniformly under their hex event ID as the doc ID.
   * For replaceable/addressable events, after the bulk index, an
   * `updateByQuery` marks older versions of the same slot as
   * `replaced: true` and strips their score fields.
   *
   * Historical documents persist indefinitely unless explicitly deleted
   * (kind 5 or kind 62). For frequently-updated kinds (e.g. kind 0
   * profiles, kind 3 contact lists), this means storage grows with each
   * replacement. A TTL or max-versions-per-slot pruning strategy may be
   * needed in the future for high-churn relays.
   */
  async flush(): Promise<void> {
    if (this.bulkTimer) {
      clearTimeout(this.bulkTimer);
      this.bulkTimer = null;
    }

    if (this.bulkQueue.length === 0) return;

    const entries = this.bulkQueue.splice(0);
    opensearchBulkQueueGauge.set(this.bulkQueue.length);

    // --- Phase 1: Build bulk body. All events are plain index operations.
    const body: Array<Record<string, unknown>> = [];

    for (const entry of entries) {
      body.push({
        index: { _index: this.indexName, _id: entry.docId },
      });
      body.push(entry.doc as unknown as Record<string, unknown>);
    }

    const flushEnd = opensearchFlushDurationHistogram.startTimer();
    try {
      const response = await this.writeClient.bulk({ body });
      flushEnd();

      // Resolve/reject entries.  Each resolve() resumes handleEvent() which
      // calls broadcast() — but broadcast() now just queues the event and the
      // actual fan-out is drained asynchronously with yields in the Relay, so
      // resolving all entries here is cheap and doesn't block the event loop.
      if (response.body.errors) {
        const items: Array<Record<string, { error?: unknown }>> =
          response.body.items;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const result = item.index as { error?: unknown } | undefined;
          if (result?.error) {
            entries[i].reject(
              new Error(`Bulk index failed: ${JSON.stringify(result.error)}`),
            );
          } else {
            opensearchEventsCounter.inc({ kind: entries[i].event.kind });
            entries[i].resolve();
          }
        }
      } else {
        for (let i = 0; i < entries.length; i++) {
          opensearchEventsCounter.inc({ kind: entries[i].event.kind });
          entries[i].resolve();
        }
      }

      // Accumulate referenced event IDs for deferred score recomputation
      // by recomputeScores(), avoiding a race where a referencing event
      // and its target arrive in the same bulk batch.
      this.collectDirtyReferences(entries);
    } catch (error) {
      flushEnd();
      // Entire bulk request failed — reject all entries
      const err = error instanceof Error ? error : new Error(String(error));
      for (const entry of entries) {
        entry.reject(err);
      }
    }

    // --- Phase 2: Mark older replaceable/addressable versions as replaced.
    // Fire-and-forget so it doesn't block the event loop for incoming REQs.
    // Between Phase 1 and Phase 2 completion, queries may briefly return
    // both old and new versions — Nostr clients handle duplicate events.
    //
    // Phase 2 needs to search for the just-indexed documents. Rather than
    // forcing an expensive `refresh: true` on the bulk request (which holds
    // an HTTP connection for 1-2s and causes head-of-line blocking for read
    // queries), we wait for the next natural refresh cycle (refresh_interval
    // defaults to 1s) before running the slot resolution search.
    const hasReplaceable = entries.some(
      (e) =>
        NKinds.replaceable(e.event.kind) || NKinds.addressable(e.event.kind),
    );
    if (hasReplaceable) {
      if (this.refreshDelayMs > 0) {
        setTimeout(() => {
          this.resolveReplaceableSlots(entries).catch((err) =>
            this.log.warn("phase2_failed", errFields(err)),
          );
        }, this.refreshDelayMs);
      } else {
        this.resolveReplaceableSlots(entries).catch((err) =>
          this.log.warn("phase2_failed", errFields(err)),
        );
      }
    }
  }

  /**
   * Acquire a slot in the Phase 2 concurrency semaphore. Resolves
   * immediately if capacity is available; otherwise queues until
   * {@link releasePhase2Slot} is called.
   *
   * If the waiter queue is full ({@link MAX_PHASE2_WAITERS}), returns
   * `false` so the caller can drop the task. Dropping is safe — the next
   * replacement event for any affected slot will re-trigger cleanup. The
   * cap prevents unbounded waiter accumulation under sustained overload.
   */
  private async acquirePhase2Slot(): Promise<boolean> {
    if (this.phase2InFlight < OpenSearchRelay.MAX_PHASE2_CONCURRENCY) {
      this.phase2InFlight++;
      return true;
    }
    if (this.phase2Waiters.length >= OpenSearchRelay.MAX_PHASE2_WAITERS) {
      return false;
    }
    await new Promise<void>((resolve) => {
      this.phase2Waiters.push(() => {
        this.phase2InFlight++;
        resolve();
      });
    });
    return true;
  }

  /**
   * Release a previously-acquired Phase 2 slot. Wakes the next waiter if any.
   */
  private releasePhase2Slot(): void {
    this.phase2InFlight--;
    const next = this.phase2Waiters.shift();
    if (next) next();
  }

  /**
   * Bulk-import historical events without disturbing documents already in
   * the index.
   *
   * Unlike {@link event}, which indexes unconditionally, this issues bulk
   * `create` operations, so an event whose id is already stored is left
   * exactly as it is. That distinction is the whole point:
   * {@link eventToDocument} rebuilds a document from the event alone, which
   * means it always carries `deleted: false`, `replaced: false` and zeroed
   * score fields. Overwriting a live document with one would discard its
   * accumulated engagement counts and resurrect anything that had been
   * soft-deleted. Importing is therefore idempotent, and safe to re-run
   * over a dump that overlaps data the relay already holds.
   *
   * Slot reconciliation for replaceable and addressable kinds is deferred
   * unless `resolveSlots` is set. A bulk import touches the same slot many
   * times (every historical version of a profile is its own event), so a
   * caller streaming a large dump should collect the affected events, keep
   * the newest per slot, and make one {@link resolveSlotsFor} call at the
   * end rather than paying for an msearch per batch.
   *
   * Deletion requests are stored like any other event but are NOT applied:
   * honoring kind 5 and kind 62 is protocol-layer work (see
   * `applyDeletionRequest` in `deletions.ts`), and a caller importing a dump
   * has to apply them in its own pass.
   */
  async importEvents(
    events: NostrEvent[],
    opts?: { resolveSlots?: boolean },
  ): Promise<ImportResult> {
    if (events.length === 0) {
      return { created: 0, skipped: 0, failed: 0, retryable: [], errors: [] };
    }

    // Documents are built straight into the request body and never kept
    // alongside it. Holding them — as a parallel array of entries, say —
    // keeps several MB per batch alive across the `await` below, which is
    // long enough for a bulk import to promote all of it out of the nursery
    // and into a generation JavaScriptCore collects far more lazily. That
    // alone grew the importer past 8 GB RSS at ~25k events/s while the same
    // run against already-indexed events, where nothing was retained, held
    // flat at 0.3 GB.
    const body: Array<Record<string, unknown>> = [];
    for (const event of events) {
      body.push({
        create: { _index: this.indexName, _id: this.getDocumentId(event) },
      });
      body.push(
        this.eventToDocument(event) as unknown as Record<string, unknown>,
      );
    }

    const flushEnd = opensearchFlushDurationHistogram.startTimer();
    let response: Awaited<ReturnType<Client["bulk"]>>;
    try {
      response = await this.writeClient.bulk({ body });
    } finally {
      flushEnd();
      // The client has serialised the body; drop the documents now rather
      // than at the end of the call.
      body.length = 0;
    }

    const result: ImportResult = {
      created: 0,
      skipped: 0,
      failed: 0,
      retryable: [],
      errors: [],
    };

    // Only events actually written can change a slot's outcome; a skipped
    // duplicate leaves the index exactly as the last pass left it. Collected
    // only when the caller asked for slot resolution — a streaming import
    // defers it to a later pass and would otherwise retain the batch here.
    const createdEvents: NostrEvent[] | null = opts?.resolveSlots ? [] : null;

    const items = (response.body.items ?? []) as Array<
      Record<string, { status?: number; error?: unknown } | undefined>
    >;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]?.create;
      if (!item?.error) {
        result.created++;
        createdEvents?.push(events[i]);
        opensearchEventsCounter.inc({ kind: events[i].kind });
      } else if (item.status === 409) {
        // version_conflict_engine_exception: this id is already indexed.
        // The stored document wins — see the note on score fields above.
        result.skipped++;
      } else if (RETRYABLE_STATUSES.has(item.status ?? 0)) {
        result.retryable.push(events[i]);
      } else {
        result.failed++;
        if (result.errors.length < IMPORT_ERROR_SAMPLE_SIZE) {
          result.errors.push(clip(JSON.stringify(item.error), 500));
        }
      }
    }

    if (createdEvents !== null && createdEvents.length > 0) {
      await this.resolveSlotsFor(createdEvents);
    }

    return result;
  }

  /**
   * Resolve a batch of filters to the ids they match, in one msearch.
   *
   * The bulk importer's deletion pass needs this. A NIP-09 `a` tag names a
   * coordinate rather than an id, and {@link remove} answers one filter with
   * one `updateByQuery` — fine for a single live deletion request, hopeless
   * for the 2.7M distinct coordinates in a dump, which at any achievable
   * rate is days of work. Resolving them to ids a hundred filters at a time
   * and handing those to {@link markDeletedByIds} turns it into thousands of
   * round trips instead of millions.
   *
   * Visibility matches {@link remove}: replaced history, auth-protected
   * kinds and expired-but-stored events are all in scope, because a
   * deletion request reaches things a REQ would not show.
   *
   * `size` caps the ids returned per filter. A coordinate with more stored
   * versions than that keeps its oldest ones, which the next pass over the
   * same coordinate would pick up.
   */
  async queryIdsBatch(
    filters: NostrFilter[],
    opts?: { size?: number },
  ): Promise<string[][]> {
    if (filters.length === 0) return [];

    const size = opts?.size ?? 100;
    const requests = filters.map((filter) => ({
      index: this.indexName,
      body: {
        query: this.buildQuery(filter, {
          includeReplaced: true,
          includeAuthKinds: true,
          includeExpired: true,
          // Resolving ids for import must see every stored version,
          // spam-flagged or not.
          includeSpam: true,
        }),
        size,
        _source: ["id"],
      },
    }));

    opensearchQueriesCounter.inc({ type: "import_id_resolution" });
    const response = await this.client.msearch(requests);
    const responses =
      (
        response.body as {
          responses?: Array<{
            hits?: { hits?: Array<{ _source?: { id: string } }> };
          }>;
        }
      ).responses ?? [];

    return filters.map((_, i) =>
      (responses[i]?.hits?.hits ?? [])
        .map((hit) => hit._source?.id)
        .filter((id): id is string => typeof id === "string"),
    );
  }

  /**
   * Make everything written so far searchable.
   *
   * Ingest writes with `refresh: false` and lets the index's own
   * `refresh_interval` catch up, which is right for the live path but leaves
   * a bulk importer unable to see what it just wrote. The import phases that
   * read back — slot resolution and deletion replay — call this first so
   * they aren't reasoning about a stale view.
   *
   * Cheap relative to what follows, but not free: don't call it per batch.
   */
  async refreshIndex(): Promise<void> {
    await this.writeClient.indices.refresh({ index: this.indexName });
  }

  /**
   * Apply partial-document updates by id in a single bulk request, returning
   * how many documents were updated.
   *
   * The counterpart to {@link queryIdsBatch} for maintenance scripts that
   * would otherwise reach for `updateByQuery`. That endpoint is a poor fit
   * for them twice over: it re-runs the query server-side when the caller
   * has already resolved exactly which documents it means, and under Bun its
   * long-running requests fail with `Malformed_HTTP_Response` often enough
   * to sink an hours-long backfill — where `bulk` carried 95M documents
   * through the same client without a single transport failure.
   *
   * Ids that don't exist are ignored, so callers may pass stale targets.
   */
  async bulkUpdateDocs(
    updates: Array<{ id: string; doc: Record<string, unknown> }>,
  ): Promise<number> {
    if (updates.length === 0) return 0;

    const body: Array<Record<string, unknown>> = [];
    for (const update of updates) {
      body.push({ update: { _index: this.indexName, _id: update.id } });
      body.push({ doc: update.doc });
    }

    const response = await this.writeClient.bulk({ body });

    const items = (response.body.items ?? []) as Array<
      Record<string, { error?: unknown } | undefined>
    >;

    let updated = 0;
    for (const item of items) {
      if (!item.update?.error) updated++;
    }
    return updated;
  }

  /**
   * Soft-delete documents by id in a single bulk request, returning how many
   * were updated.
   *
   * This is the deletion primitive the bulk importer needs. {@link remove}
   * takes filters, builds a query and runs an `updateByQuery` with an
   * immediate refresh, which is the right shape for one live deletion
   * request but ruinous when replaying millions of historical ones. A caller
   * that has already resolved and authorized its targets — see `canDelete`
   * in `deletions.ts` — knows the exact ids and can mark a whole batch with
   * one bulk update and no forced refresh.
   *
   * Ids that don't exist in the index are silently ignored, so callers may
   * pass targets that were never stored here.
   *
   * This method does NOT authorize anything. Never hand it ids that haven't
   * been checked against the deletion request's author.
   */
  async markDeletedByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const body: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      body.push({ update: { _index: this.indexName, _id: id } });
      body.push({ doc: { deleted: true } });
    }

    const response = await this.writeClient.bulk({ body });

    const items = (response.body.items ?? []) as Array<
      Record<string, { status?: number; error?: unknown } | undefined>
    >;

    let updated = 0;
    for (const item of items) {
      const result = item.update;
      // 404 is expected and uninteresting: the dump referenced an event this
      // relay never stored.
      if (!result?.error) updated++;
    }

    return updated;
  }

  /**
   * Reconcile replaceable/addressable slots for events that are already in
   * the index, marking every version but the NIP-01 winner `replaced: true`.
   *
   * This is the deferred half of {@link importEvents}. Running it after
   * ingest — once the index has been refreshed and every imported version is
   * searchable — is what lets a bulk import of historical data converge on
   * one live version per slot. Events of non-replaceable kinds are ignored,
   * so a caller can pass a batch unfiltered.
   */
  async resolveSlotsFor(events: SlotEvent[]): Promise<void> {
    const entries: SlotCandidate[] = events
      .filter(
        (event) =>
          NKinds.replaceable(event.kind) || NKinds.addressable(event.kind),
      )
      .map((event) => ({ event }));

    if (entries.length === 0) return;

    await this.resolveReplaceableSlots(entries);
  }

  /**
   * Phase 2 of flush: for replaceable/addressable events, find the slot
   * winner and mark all losers as `replaced: true` (or delete them for
   * excluded kinds).  Runs asynchronously so it doesn't block the main
   * event loop.
   *
   * The winner is decided over the union of the just-indexed event and
   * the versions the `msearch` could see, because Phase 1 waits only one
   * refresh_interval and the new document is not reliably searchable by
   * then. It is never assumed to be the top hit.
   *
   * Batched implementation:
   *   1. One {@link Client.msearch} over all slots returns a peek at the
   *      slot's live versions (`size: 3`). Routed through the read client
   *      since it's a single query per flush. Counted as `slot_resolution`.
   *   2. Slots with no losers are skipped — a fast-path that dominates
   *      first-time-write workloads (e.g. Bluesky bridge backfill).
   *   3. Slots that need cleanup are resolved in at most three combined
   *      ops:
   *        - history-preserving losers: one bulk partial-doc `update` per
   *          known loser id, skipping losers that were concurrently
   *          soft-deleted. Counted as `slot_cleanup_history`.
   *        - excluded-kind losers: a single `deleteByQuery` over all
   *          slots. Counted as `slot_cleanup_delete`.
   *        - deep-history sweep: a single `updateByQuery` covering slots
   *          whose msearch hit its size cap, in case stragglers exist
   *          behind the visible loser. Counted as `slot_cleanup_deep`.
   *
   * Phase 2 is wrapped by a class-wide semaphore
   * ({@link MAX_PHASE2_CONCURRENCY}) so concurrent flushes cannot stack
   * and starve REQ traffic. When the waiter queue overflows
   * ({@link MAX_PHASE2_WAITERS}), excess tasks are dropped — the
   * deep-history fallback ensures the next replacement event for an
   * affected slot still picks up any stragglers.
   */
  private async resolveReplaceableSlots(
    entries: SlotCandidate[],
  ): Promise<void> {
    const acquired = await this.acquirePhase2Slot();
    if (!acquired) {
      opensearchPhase2DroppedCounter.inc();
      this.log.warn("phase2_dropped", {
        max_waiters: OpenSearchRelay.MAX_PHASE2_WAITERS,
      });
      return;
    }
    try {
      await this.resolveReplaceableSlotsInner(entries);
    } finally {
      this.releasePhase2Slot();
    }
  }

  private async resolveReplaceableSlotsInner(
    entries: SlotCandidate[],
  ): Promise<void> {
    type Slot = {
      kind: number;
      pubkey: string;
      dTag: string;
      eventId: string;
      createdAt: number;
    };

    /** A candidate version of a slot, as returned by the msearch. */
    type SlotDoc = { id: string; created_at: number; deleted?: boolean };

    /** NIP-01 slot ordering: newest wins, lowest id breaks ties. */
    const beats = (a: SlotDoc, b: SlotDoc): boolean =>
      a.created_at > b.created_at ||
      (a.created_at === b.created_at && a.id < b.id);

    const slots = new Map<string, Slot>();

    for (const entry of entries) {
      if (
        !NKinds.replaceable(entry.event.kind) &&
        !NKinds.addressable(entry.event.kind)
      ) {
        continue;
      }

      const dTag = NKinds.addressable(entry.event.kind)
        ? entry.event.tags.find(([name]) => name === "d")?.[1] || ""
        : "";
      const slotKey = `${entry.event.kind}:${entry.event.pubkey}:${dTag}`;

      const existing = slots.get(slotKey);
      // If multiple events for the same slot in one batch, keep the newest
      // (or lowest ID at same timestamp) — that's the one that should remain
      // as the current version.
      if (
        !existing ||
        entry.event.created_at > existing.createdAt ||
        (entry.event.created_at === existing.createdAt &&
          entry.event.id < existing.eventId)
      ) {
        slots.set(slotKey, {
          kind: entry.event.kind,
          pubkey: entry.event.pubkey,
          dTag,
          eventId: entry.event.id,
          createdAt: entry.event.created_at,
        });
      }
    }

    if (slots.size === 0) return;

    // Build the must-clauses for a single slot, used both in the per-slot
    // msearch and in any cleanup query covering that slot.
    const buildSlotMust = (slot: Slot): Record<string, unknown>[] => {
      const must: Record<string, unknown>[] = [
        { term: { kind: slot.kind } },
        { term: { pubkey: slot.pubkey } },
        { term: { deleted: false } },
        { term: { replaced: false } },
      ];
      if (NKinds.addressable(slot.kind)) {
        must.push({ term: { "tags_map.d": slot.dTag } });
      }
      return must;
    };

    const slotList = Array.from(slots.values());

    // --- Step 1: One msearch over all slots, returning each slot's top 3
    // candidates. We need `size: 3` (not 2) so we can distinguish:
    //
    //   - hits.length === 1 → only the just-indexed event, no prior version
    //   - hits.length === 2 → exactly one prior version (the common case;
    //     can be resolved with a single partial-doc update by id)
    //   - hits.length === 3 → msearch hit the size cap; older stragglers
    //     may exist behind the visible loser, schedule a deep-history sweep
    //
    // Routes through the read client because it's a single query per flush
    // regardless of slot count; the write pool is the hot resource during
    // replaceable-event floods (Phase 1 bulk + Phase 2 cleanup both hit
    // it), so reads belong on the read pool where they can run in parallel
    // with ongoing writes.
    const msearchRequests = slotList.map((slot) => ({
      index: this.indexName,
      body: {
        query: { bool: { must: buildSlotMust(slot) } },
        sort: [{ created_at: { order: "desc" } }, { id: { order: "asc" } }],
        size: 3,
        _source: ["id", "created_at", "deleted"],
      },
    }));

    opensearchQueriesCounter.inc({ type: "slot_resolution" });
    const slotEnd = opensearchQueryDurationHistogram.startTimer({
      type: "slot_resolution",
    });
    let msearchResponses: Array<{
      hits?: {
        hits?: Array<{ _source?: SlotDoc }>;
      };
    }>;
    try {
      const result = await this.client.msearch(msearchRequests);
      slotEnd();
      msearchResponses =
        (
          result.body as {
            responses?: Array<{
              hits?: {
                hits?: Array<{
                  _source?: SlotDoc;
                }>;
              };
            }>;
          }
        ).responses ?? [];
    } catch (error) {
      slotEnd();
      this.log.warn("phase2_msearch_failed", errFields(error));
      return;
    }

    // --- Step 2: Categorize each slot.
    //
    // history losers:   slot's kind preserves history AND msearch returned
    //                   exactly one prior version (hits.length === 2).
    //                   Resolved by partial-doc update by id in 3a.
    //
    // delete slots:     slot's kind is excluded from history retention,
    //                   regardless of how many priors are visible. The
    //                   batched deleteByQuery in 3b doesn't have a size
    //                   cap so it cleans deep history transparently.
    //
    // deep-history:     slot's kind preserves history AND msearch hit its
    //                   size cap (hits.length === 3). Stragglers may exist
    //                   behind the visible window — resolved by a scoped
    //                   updateByQuery sweep in 3c so the system self-heals
    //                   on every Phase 2 pass instead of waiting for a
    //                   future replacement event.
    type Loser = { slot: Slot; loserId: string };
    const historyLosers: Loser[] = [];
    const unsearchableDeleteIds: string[] = [];
    const deleteSlots: Slot[] = [];
    const deleteWinnerIds: string[] = [];
    const deepHistorySlots: Slot[] = [];
    const deepHistoryWinnerIds: string[] = [];

    for (let i = 0; i < slotList.length; i++) {
      const slot = slotList[i];
      const resp = msearchResponses[i];
      const hits = (resp?.hits?.hits ?? [])
        .map((hit) => hit._source)
        .filter((source): source is SlotDoc => !!source?.id);

      // The just-indexed event competes for the slot even when it is not
      // searchable yet: Phase 1 only waits one refresh_interval, so an
      // msearch that outruns the refresh cycle can't see it. Taking
      // `hits[0]` as the winner in that case crowns the previous version
      // and leaves the new one unreplaced forever — the slot converges on
      // two live versions instead of one — and lets the sweeps below
      // replace or delete the event that should have won.
      const indexed: SlotDoc = {
        id: slot.eventId,
        created_at: slot.createdAt,
      };
      const indexedSearchable = hits.some((hit) => hit.id === indexed.id);
      const candidates = indexedSearchable ? hits : [...hits, indexed];

      let winner = candidates[0];
      for (const candidate of candidates) {
        if (beats(candidate, winner)) winner = candidate;
      }

      // Losers that were concurrently soft-deleted (NIP-09) are skipped:
      // overwriting one would clobber `deleted: true` back to
      // `replaced: true` and resurrect the doc into history queries. It's
      // already excluded from queries by the `deleted: false` filter, so
      // leaving it alone is correct.
      const loserIds = candidates
        .filter((c) => c.id !== winner.id && c.deleted !== true)
        .map((c) => c.id);

      // Nothing to clean up. Common case for first-write events (e.g.
      // brand-new bridge accounts): skip the cleanup query and the
      // partial-doc update entirely.
      if (loserIds.length === 0) continue;

      // An older version arriving late loses to what's already stored. No
      // query-based sweep can reach it while it's unsearchable, so it has
      // to be named by id.
      const indexedLost = !indexedSearchable && winner.id !== indexed.id;

      const preserve = this.shouldPreserveHistory(slot.kind);
      const hitDeepHistory = hits.length >= 3;

      if (hitDeepHistory) {
        // msearch hit its size cap; stragglers may exist. Tracked in
        // metrics — in healthy operation this counter should stay near
        // zero. The deep-history sweep in 3c covers preserve-history
        // slots; excluded-kind slots are handled fully by 3b which has
        // no size cap.
        opensearchSlotDeepHistoryCounter.inc();
      }

      if (preserve) {
        if (hitDeepHistory) {
          // Defer entirely to the scoped updateByQuery sweep in 3c, which
          // covers every straggler in the slot. Skipping 3a here avoids
          // double-writing the visible losers.
          deepHistorySlots.push(slot);
          deepHistoryWinnerIds.push(winner.id);
          if (indexedLost) historyLosers.push({ slot, loserId: indexed.id });
        } else {
          for (const loserId of loserIds) {
            historyLosers.push({ slot, loserId });
          }
        }
      } else {
        deleteSlots.push(slot);
        deleteWinnerIds.push(winner.id);
        if (indexedLost) unsearchableDeleteIds.push(indexed.id);
      }

      // Mark kind 0 pubkey as dirty so follower count gets recomputed on
      // the next recomputeScores() cycle. Follower counts are pubkey-based
      // (from kind 3 contact lists), so they transfer to the new profile
      // event automatically.
      if (
        slot.kind === 0 &&
        this.pendingDirtyPubkeys.size < OpenSearchRelay.MAX_PENDING_DIRTY
      ) {
        this.pendingDirtyPubkeys.add(slot.pubkey);
      }
    }

    // --- Step 3: Cleanup. At most three round-trips total per flush
    // (history bulk update + delete sweep + deep-history sweep), and only
    // when each path has slots to act on.
    //
    // 3a. Bulk partial-doc update of known history losers, plus by-id
    //     deletes for excluded-kind losers the query sweep in 3b can't
    //     reach. Avoids the painless script entirely, which is much
    //     cheaper than updateByQuery (no script compile/cache, no query
    //     scan, direct doc-id lookup on the write thread pool).
    if (historyLosers.length > 0 || unsearchableDeleteIds.length > 0) {
      opensearchQueriesCounter.inc({ type: "slot_cleanup_history" });
      const cleanupEnd = opensearchQueryDurationHistogram.startTimer({
        type: "slot_cleanup_history",
      });
      try {
        const bulkBody: Array<Record<string, unknown>> = [];
        for (const { loserId } of historyLosers) {
          bulkBody.push({
            update: { _index: this.indexName, _id: loserId },
          });
          bulkBody.push({ doc: REPLACED_DOC });
        }
        for (const loserId of unsearchableDeleteIds) {
          bulkBody.push({
            delete: { _index: this.indexName, _id: loserId },
          });
        }
        await this.writeClient.bulk({ body: bulkBody });
      } catch (error) {
        this.log.warn("phase2_history_update_failed", errFields(error));
      } finally {
        cleanupEnd();
      }
    }

    // 3b. Single combined deleteByQuery for slots whose kind is excluded
    //     from history retention. All such slots collapsed into one HTTP
    //     round-trip via a bool.should over the per-slot must-clauses,
    //     with the slot winners excluded so they survive. No size cap, so
    //     deep history is handled transparently here.
    if (deleteSlots.length > 0) {
      opensearchQueriesCounter.inc({ type: "slot_cleanup_delete" });
      const deleteEnd = opensearchQueryDurationHistogram.startTimer({
        type: "slot_cleanup_delete",
      });
      try {
        const should = deleteSlots.map((slot) => ({
          bool: { must: buildSlotMust(slot) },
        }));
        await this.writeClient.deleteByQuery({
          index: this.indexName,
          body: {
            query: {
              bool: {
                should,
                minimum_should_match: 1,
                must_not:
                  deleteWinnerIds.length > 0
                    ? [{ ids: { values: deleteWinnerIds } }]
                    : [],
              },
            },
          },
          refresh: false,
          conflicts: "proceed",
        });
      } catch (error) {
        this.log.warn("phase2_delete_sweep_failed", errFields(error));
      } finally {
        deleteEnd();
      }
    }

    // 3c. Deep-history sweep for history-preserving slots where msearch
    //     hit its size cap (≥1 straggler likely exists behind the visible
    //     window). Uses a scoped `updateByQuery` painless script — the
    //     only path that still pays the script-compile cost, but only
    //     fires when 3a's fast path can't cover the slot completely.
    //
    //     This self-heals from prior cleanup failures: without it, a
    //     transient OpenSearch error during 3a would leave stragglers in
    //     a slot indefinitely (until the next replacement event for that
    //     slot, which may never come for inactive accounts).
    if (deepHistorySlots.length > 0) {
      opensearchQueriesCounter.inc({ type: "slot_cleanup_deep" });
      const deepEnd = opensearchQueryDurationHistogram.startTimer({
        type: "slot_cleanup_deep",
      });
      try {
        const should = deepHistorySlots.map((slot) => ({
          bool: { must: buildSlotMust(slot) },
        }));
        await this.writeClient.updateByQuery({
          index: this.indexName,
          body: {
            query: {
              bool: {
                should,
                minimum_should_match: 1,
                must_not: [{ ids: { values: deepHistoryWinnerIds } }],
              },
            },
            script: {
              source: REPLACED_PAINLESS,
              lang: "painless",
            },
          },
          refresh: false,
          conflicts: "proceed",
        });
      } catch (error) {
        this.log.warn("phase2_deep_sweep_failed", errFields(error));
      } finally {
        deepEnd();
      }
    }
  }

  /**
   * Determine whether a given kind should preserve historical versions
   * when replaced. The logic is:
   *
   * 1. If history is globally disabled → false
   * 2. If a whitelist is set → true only if the kind is in the whitelist
   * 3. Otherwise → true unless the kind is in the exclude list
   */
  private shouldPreserveHistory(kind: number): boolean {
    if (!this.historyEnabled) return false;
    if (this.historyKindsWhitelist) {
      return this.historyKindsWhitelist.has(kind);
    }
    return !this.historyKindsExcluded.has(kind);
  }

  /** Kinds whose `e`-tag references affect engagement scores. */
  private static REFERENCING_KINDS = new Set([
    1, 6, 7, 16, 17, 1111, 9735, 8333,
  ]);

  /**
   * After indexing referencing events, accumulate the target event IDs and
   * followed pubkeys into in-memory sets for deferred score recomputation.
   * {@link recomputeScores} drains these sets and fetches the events
   * directly — by that time all recently-indexed documents are searchable.
   *
   * Also notifies the NIP-85 publisher about dirty addressable event and
   * external identifier references via callbacks.
   */
  private collectDirtyReferences(entries: BulkEntry[]): void {
    const referencedAddrs = new Set<string>();
    const referencedIdentifiers = new Set<string>();

    // Cap-aware helpers. Once either set is full, subsequent additions are
    // dropped until the next drain. We use these instead of direct `.add()`
    // so a single flood of referencing events cannot amplify into unbounded
    // recomputeScores() work.
    const addDirtyId = (id: string): void => {
      this.addDirtyId(id);
    };
    const addDirtyPubkey = (pk: string): void => {
      this.addDirtyPubkey(pk);
    };

    for (const entry of entries) {
      // Engagement-referencing events: accumulate target event IDs,
      // and collect addressable event references via `a` tags.
      if (OpenSearchRelay.REFERENCING_KINDS.has(entry.event.kind)) {
        // NIP-25: For kind 7 reactions, only the last e tag is the target.
        if (entry.event.kind === 7) {
          for (let i = entry.event.tags.length - 1; i >= 0; i--) {
            if (entry.event.tags[i][0] === "e" && entry.event.tags[i][1]) {
              addDirtyId(entry.event.tags[i][1]);
              break;
            }
          }
        }

        for (const tag of entry.event.tags) {
          if (tag[0] === "e" && tag[1] && entry.event.kind !== 7) {
            addDirtyId(tag[1]);
          } else if (tag[0] === "q" && tag[1]) {
            // NIP-18: Quote reposts reference the quoted event via `q` tag.
            addDirtyId(tag[1]);
          } else if (tag[0] === "a" && tag[1]) {
            referencedAddrs.add(tag[1]);
          } else if (tag[0] === "i" && tag[1]) {
            referencedIdentifiers.add(tag[1]);
          } else if (tag[0] === "I" && tag[1] && entry.event.kind === 1111) {
            referencedIdentifiers.add(tag[1]);
          }
        }
      }

      // Kind 3 (contact list): accumulate followed pubkeys so their
      // kind 0 events get marked dirty for follower count recomputation.
      if (entry.event.kind === 3) {
        for (const tag of entry.event.tags) {
          if (tag[0] === "p" && tag[1]) {
            addDirtyPubkey(tag[1]);
          }
        }
      }
    }

    // Notify NIP-85 publisher about dirty addressable event references.
    if (referencedAddrs.size > 0) {
      this.onDirtyAddrs?.(referencedAddrs);
    }

    // Notify NIP-85 publisher about dirty external identifier references.
    if (referencedIdentifiers.size > 0) {
      this.onDirtyIdentifiers?.(referencedIdentifiers);
    }
  }

  /**
   * Drain the in-memory pending dirty sets and return their contents.
   * Replaces each set with a fresh empty one so that concurrent
   * `collectDirtyReferences()` calls from `flush()` are not affected.
   */
  private drainPendingDirty(): {
    ids: Set<string>;
    pubkeys: Set<string>;
  } {
    const ids = this.pendingDirtyIds;
    this.pendingDirtyIds = new Set();
    const pubkeys = this.pendingDirtyPubkeys;
    this.pendingDirtyPubkeys = new Set();
    this.dirtyOverflowWarned = false;
    return { ids, pubkeys };
  }

  /**
   * Query events from OpenSearch
   */
  async query(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal; includeAuthKinds?: boolean },
  ): Promise<NostrEvent[]> {
    const allEvents: NostrEvent[] = [];
    const seenIds = new Set<string>();

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }
      try {
        const events = await this.queryFilter(
          filter,
          opts?.signal,
          opts?.includeAuthKinds,
        );

        // Deduplicate events across filters
        for (const event of events) {
          if (!seenIds.has(event.id)) {
            seenIds.add(event.id);
            allEvents.push(event);
          }
        }
      } catch (error) {
        this.log.error("filter_query_failed", {
          filters: clip(JSON.stringify(filter)),
          ...errFields(error),
        });
      }
    }

    return allEvents;
  }

  /**
   * Fetch the `(created_at, id)` pairs of events matching a filter, sorted
   * ascending by `created_at` with ties broken by `id` bytes ascending —
   * exactly the record ordering required by NIP-77 Negentropy set
   * reconciliation. (`id` is a keyword field holding lowercase hex, so its
   * lexical order equals byte order.)
   *
   * Uses `search_after` pagination so result sets are not bounded by
   * `index.max_result_window`.
   *
   * A NIP-01 `limit` on the filter bounds the set to the N *newest*
   * matching events (matching strfry's NIP-77 semantics): pages are
   * fetched descending and the result is reversed back to ascending.
   * Without a `limit`, the full matching set is returned, bounded only by
   * `opts.maxItems` (the relay layer enforces its own record cap and
   * returns `NEG-ERR blocked:` when exceeded).
   *
   * Deleted, replaced, and expired documents are excluded, and
   * auth-protected kinds are excluded from filters that don't explicitly
   * request them — the same visibility rules as REQ queries.
   */
  async queryItems(
    filter: NostrFilter,
    opts?: {
      maxItems?: number;
      pageSize?: number;
      signal?: AbortSignal;
      includeAuthKinds?: boolean;
    },
  ): Promise<SyncItem[]> {
    const limit = typeof filter.limit === "number" ? filter.limit : undefined;
    const maxItems = Math.min(
      opts?.maxItems ?? 1_000_000,
      limit ?? Number.POSITIVE_INFINITY,
    );
    const pageSize = opts?.pageSize ?? 10_000;
    // With a limit we want the newest N, so iterate descending and reverse
    // at the end; otherwise iterate ascending directly.
    const order = limit === undefined ? ("asc" as const) : ("desc" as const);
    const query = this.buildQuery(filter, {
      includeAuthKinds: opts?.includeAuthKinds,
      // NIP-77 reconciliation must reflect what is actually stored. Hiding
      // spam here would make us claim not to have events we do have, and the
      // peer would re-offer them on every sync, forever.
      includeSpam: true,
    });
    const items: SyncItem[] = [];

    opensearchQueriesCounter.inc({ type: "sync" });
    const end = opensearchQueryDurationHistogram.startTimer({ type: "sync" });

    try {
      let searchAfter: Array<string | number> | undefined;

      while (items.length < maxItems) {
        if (opts?.signal?.aborted) break;

        const size = Math.min(pageSize, maxItems - items.length);
        const body: Record<string, unknown> = {
          _source: ["created_at", "id"],
          query,
          sort: [{ created_at: { order } }, { id: { order } }],
          size,
          track_total_hits: false,
        };
        if (searchAfter) {
          body.search_after = searchAfter;
        }

        const response = await this.client.search<{
          created_at: number;
          id: string;
        }>({
          index: this.indexName,
          body,
        });

        const hits = response.body.hits.hits;

        if (hits.length === 0) break;

        for (const hit of hits) {
          if (hit._source) {
            items.push({
              created_at: hit._source.created_at,
              id: hit._source.id,
            });
          }
        }

        if (hits.length < size) break; // Last page.
        searchAfter = hits[hits.length - 1].sort;
        if (!searchAfter) break; // Defensive: cannot paginate without sort values.
      }

      end();
      // Descending (limited) iteration must be flipped back to the
      // ascending order Negentropy requires.
      if (order === "desc") items.reverse();
      return items;
    } catch (error) {
      end();
      this.log.error("sync_query_failed", errFields(error));
      throw error;
    }
  }

  /**
   * Count events matching the given filters (NIP-45)
   * Uses OpenSearch count API for efficiency. For multiple filters, sums the counts
   * and marks as approximate since we don't deduplicate across filters.
   *
   * When distinct:author is present, uses a cardinality aggregation on pubkey
   * to return the number of unique authors instead of total events.
   *
   * A count is the one read that cannot post-filter expired events the way
   * {@link hitsToEvents} does — there are no documents to inspect — so it
   * may include events that expired within the current
   * EXPIRATION_BUCKET_SECONDS. NIP-45 counts are already advertised as
   * approximate.
   */
  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal; includeAuthKinds?: boolean },
  ): Promise<{ count: number; approximate?: boolean }> {
    let totalCount = 0;
    let approximate: boolean | undefined;

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }

      try {
        const query = this.buildQuery(filter, {
          includeAuthKinds: opts?.includeAuthKinds,
        });

        opensearchQueriesCounter.inc({ type: "count" });
        const countEnd = opensearchQueryDurationHistogram.startTimer({
          type: "count",
        });

        if (this.collapseClause(filter)) {
          // Use cardinality aggregation for distinct author count.
          // precision_threshold controls HyperLogLog++ precision: lower values
          // are significantly faster on large result sets at the cost of some
          // accuracy (still very good for counts above the threshold).
          // A 10s timeout ensures the query returns partial results rather than
          // hanging indefinitely on broad filters.
          const response = await this.client.search({
            index: this.indexName,
            body: {
              query,
              size: 0,
              timeout: "5s",
              aggs: {
                unique_authors: {
                  cardinality: {
                    field: "pubkey",
                    precision_threshold: 100,
                  },
                },
              },
            },
          });
          countEnd();

          const cardinality = response.body.aggregations?.unique_authors as
            | { value: number }
            | undefined;
          totalCount += cardinality?.value ?? 0;
          // Cardinality aggregation is inherently approximate
          approximate = true;
        } else {
          // Use count API - much more efficient than search, no document fetching
          const response = await this.client.count({
            index: this.indexName,
            body: { query },
          });
          countEnd();

          totalCount += response.body.count;
        }
      } catch (error) {
        this.log.error("count_filter_failed", {
          filters: clip(JSON.stringify(filter)),
          ...errFields(error),
        });
      }
    }

    // Mark as approximate if multiple filters or cardinality was used
    if (filters.length > 1) {
      approximate = true;
    }

    return {
      count: totalCount,
      approximate,
    };
  }

  /**
   * Resolve the ids a limited {@link remove} should delete: the newest
   * `filter.limit` events matching `query`, newest first. The index is sorted
   * `created_at` desc, so this is a top-N read rather than a full scan.
   */
  private async resolveRemoveIds(
    filter: NostrFilter,
    query: Record<string, unknown>,
  ): Promise<string[]> {
    const size = Math.min(
      filter.limit ?? OpenSearchRelay.MAX_RESULT_WINDOW,
      OpenSearchRelay.MAX_RESULT_WINDOW,
    );

    const response = await this.client.search<{ id: string }>({
      index: this.indexName,
      body: {
        _source: ["id"],
        query: { bool: query },
        sort: [{ created_at: { order: "desc" as const } }],
        size,
        track_total_hits: false,
      },
    });

    return response.body.hits.hits
      .map((hit) => hit._source?.id)
      .filter((id): id is string => typeof id === "string");
  }

  /**
   * Remove events matching the given filters (soft delete by setting the
   * `deleted` field), including historical (`replaced: true`) versions.
   *
   * Deletion runs entirely server-side as one `updateByQuery` per filter, so
   * it is not bounded by the search result window: NIP-62 requires a vanish
   * request to delete *everything* the pubkey wrote, however much that is.
   * For the same reason it looks past the visibility rules a REQ obeys —
   * auth-protected kinds (the author's own DMs) and expired-but-stored events
   * are still matched.
   *
   * Events whose kind is listed in `excludeKinds` are spared even when they
   * match a filter. NIP-62 vanish requests use this to delete everything a
   * pubkey authored except the gift wraps it signed, which belong to their
   * p-tagged recipients.
   *
   * A filter's `limit` is honored: `limit: N` deletes only the N newest
   * matching events (excluded kinds are skipped during selection, not after),
   * and `limit: 0` deletes nothing. A filter with no `limit` — what NIP-09
   * and NIP-62 send — deletes everything it matches, history included.
   * Limiting narrows the selection to live events; archived versions of a
   * replaceable event are only swept up by an unlimited filter.
   */
  async remove(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal; excludeKinds?: number[] },
  ): Promise<void> {
    const excludeKinds = opts?.excludeKinds ?? [];

    for (const filter of filters) {
      if (opts?.signal?.aborted) break;
      if (filter.limit === 0) continue;

      const limited = typeof filter.limit === "number";

      const bool: Record<string, unknown> = {
        must: [
          this.buildQuery(filter, {
            // A limited delete names live events; an unlimited one is a
            // sweep, so it takes replaced history with it.
            includeReplaced: !limited,
            includeAuthKinds: true,
            includeExpired: true,
            // A spam-flagged note must stay deletable — kind 5 and kind 62
            // have to reach it.
            includeSpam: true,
          }),
        ],
      };
      if (excludeKinds.length > 0) {
        bool.must_not = [{ terms: { kind: excludeKinds } }];
      }

      // A limited delete resolves the newest N ids first and then names them
      // directly; the mutation stays a single updateByQuery either way.
      let query: Record<string, unknown> = { bool };
      if (limited) {
        const ids = await this.resolveRemoveIds(filter, bool);
        if (ids.length === 0) continue;
        query = { bool: { must: [{ terms: { id: ids } }] } };
      }

      try {
        const response = await this.writeClient.updateByQuery({
          index: this.indexName,
          body: {
            query,
            script: {
              source: "ctx._source.deleted = true",
              lang: "painless",
            },
          },
          refresh: true, // Make deletions visible immediately
          conflicts: "proceed",
        });
        const { updated } = (response.body ?? {}) as { updated?: number };
        this.log.debug("soft_deleted", { count: updated ?? 0 });
      } catch (error) {
        this.log.error("soft_delete_failed", errFields(error));
        throw error;
      }
    }
  }

  /** Custom analyzer settings for edge-ngram prefix matching on profile names. */
  // biome-ignore lint/suspicious/noExplicitAny: OpenSearch settings types are dynamic
  static readonly ANALYZER_SETTINGS: Record<string, any> = {
    analysis: {
      analyzer: {
        edge_ngram_analyzer: {
          type: "custom",
          tokenizer: "edge_ngram_tokenizer",
          filter: ["lowercase"],
        },
        url_analyzer: {
          type: "custom",
          tokenizer: "uax_url_email",
          filter: ["lowercase"],
        },
      },
      tokenizer: {
        edge_ngram_tokenizer: {
          type: "edge_ngram",
          min_gram: 2,
          max_gram: 20,
          token_chars: ["letter", "digit"],
        },
      },
    },
  };

  /** Mapping properties for the Nostr events index. */
  // biome-ignore lint/suspicious/noExplicitAny: OpenSearch client types are overly strict for dynamic mappings
  static readonly MAPPING_PROPERTIES: Record<string, any> = {
    id: { type: "keyword" },
    pubkey: { type: "keyword" },
    created_at: { type: "long" },
    kind: { type: "integer" },
    tags: {
      type: "object",
      enabled: false,
    },
    tags_map: {
      type: "object",
      dynamic: "true",
    },
    content: {
      type: "object",
      enabled: false,
    },
    search_text: {
      type: "text",
      analyzer: "standard",
      fields: {
        url: {
          type: "text",
          analyzer: "url_analyzer",
        },
      },
    },
    autocomplete_text: {
      type: "text",
      analyzer: "edge_ngram_analyzer",
      search_analyzer: "standard",
    },
    sig: { type: "keyword" },
    deleted: { type: "boolean" },
    replaced: { type: "boolean" },
    protocol: { type: "keyword" },
    client: { type: "keyword" },
    amount_msats: { type: "long" },
    language: { type: "keyword" },
    sentiment: { type: "keyword" },
    media: { type: "boolean" },
    video: { type: "boolean" },
    nsfw: { type: "boolean" },
    spam_score: { type: "float" },
    pow: { type: "integer" },
    followers: { type: "integer" },
    engagers: { type: "integer" },
    comment_cnt: { type: "integer" },
    reaction_cnt: { type: "integer" },
    repost_cnt: { type: "integer" },
    quote_cnt: { type: "integer" },
    zap_amount_msats: { type: "long" },
    zap_cnt: { type: "integer" },
  };

  /**
   * Initialize OpenSearch index with mappings, or update mappings on an
   * existing index.
   *
   * OpenSearch's `putMapping` is additive — it only introduces new fields
   * and never removes or alters existing ones — so it is safe to call on
   * every startup. This ensures that newly added fields (e.g. `sentiment`)
   * are available on indices that were created before the field existed.
   */
  async migrate(): Promise<void> {
    try {
      // Check if index or alias already exists
      const exists =
        (await this.writeClient.indices.exists({ index: this.indexName }))
          .body ||
        (await this.writeClient.indices.existsAlias({ name: this.indexName }))
          .body;

      if (exists) {
        // Add custom analyzer settings (requires close/open).
        // This is idempotent — if the analyzer already exists, the close/open
        // is a harmless no-op that briefly pauses writes.
        try {
          await this.writeClient.indices.close({ index: this.indexName });
          await this.writeClient.indices.putSettings({
            index: this.indexName,
            body: { settings: OpenSearchRelay.ANALYZER_SETTINGS },
          });
          await this.writeClient.indices.open({ index: this.indexName });
          this.log.info("settings_updated", { index: this.indexName });
        } catch (e) {
          // Ensure the index is reopened even if putSettings fails.
          try {
            await this.writeClient.indices.open({ index: this.indexName });
          } catch {
            // Already open or unrecoverable — ignore.
          }
          this.log.warn("settings_update_failed", errFields(e));
        }

        // Update mappings so any new fields are added to the existing index.
        // This may fail if field types changed (e.g. content: text → object),
        // which requires a full reindex to resolve. Non-fatal — the relay can
        // still operate on the existing mapping.
        try {
          await this.writeClient.indices.putMapping({
            index: this.indexName,
            body: {
              properties: OpenSearchRelay.MAPPING_PROPERTIES,
            },
          });
          this.log.info("mappings_updated", { index: this.indexName });
        } catch (e) {
          this.log.warn("mappings_update_failed", errFields(e));
        }
        return;
      }

      // Create index with full settings and mappings.
      await this.writeClient.indices.create({
        index: this.indexName,
        body: {
          settings: {
            "sort.field": "created_at",
            "sort.order": "desc",
            number_of_shards: 3,
            number_of_replicas: 1,
            "index.max_result_window": OpenSearchRelay.MAX_RESULT_WINDOW,
            ...OpenSearchRelay.ANALYZER_SETTINGS,
          },
          mappings: {
            dynamic: "strict",
            dynamic_templates: [
              {
                tags_map_keyword: {
                  path_match: "tags_map.*",
                  mapping: { type: "keyword" },
                },
              },
            ],
            properties: OpenSearchRelay.MAPPING_PROPERTIES,
          },
        },
      });

      this.log.info("index_created", { index: this.indexName });
    } catch (error) {
      this.log.error("index_create_failed", errFields(error));
      throw error;
    }
  }

  /**
   * Recompute engagement scores for dirty events.
   *
   * Drains the in-memory pending dirty sets (event IDs and followed
   * pubkeys accumulated by {@link collectDirtyReferences}), fetches the
   * corresponding documents from OpenSearch, aggregates their referencing
   * events to compute `followers`, `engagers`, `comment_cnt`, `reaction_cnt`,
   * `repost_cnt`, and `zap_amount_msats`, then writes the scores back.
   *
   * For kind 0 (profile) events, `followers` is set to the follower count:
   * the number of unique kind 3 (contact list) events whose `p` tags
   * include this profile's pubkey.
   *
   * The two halves are disjoint by kind: Phase 2a computes `followers` for
   * kind 0 only, Phase 2b computes the engagement fields for everything
   * else, and Phase 4 writes back only the half that applies. Note this
   * leaves kind 0 engagement counts uncomputed — nothing aggregates
   * reactions or zaps *on a profile event*, so a mixed-kind or catch-all
   * `sort:top` ranks profiles by whatever `engagers` they were indexed
   * with (0). Fixing that means running Phase 2b over kind 0 too, at six
   * more sub-queries per dirty profile.
   *
   * Designed to be called periodically (e.g. via setInterval).
   * Returns the computed scores so callers (e.g. NIP-85) can publish them.
   */
  /**
   * Run an `_msearch` in chunks of at most {@link RECOMPUTE_MSEARCH_CHUNK}
   * sub-requests, concatenating the responses in request order.
   *
   * Chunks run sequentially: the goal is to keep any single OpenSearch call
   * small enough not to time out under a large dirty burst, not to add
   * concurrent load. The returned array lines up 1:1 with `searches`, so
   * positional readouts are unaffected.
   */
  private async msearchChunked(
    searches: Array<{ index: string; body: unknown }>,
  ): Promise<Array<MsearchResponseItem | undefined>> {
    const responses: Array<MsearchResponseItem | undefined> = [];
    for (let i = 0; i < searches.length; i += RECOMPUTE_MSEARCH_CHUNK) {
      const chunk = searches.slice(i, i + RECOMPUTE_MSEARCH_CHUNK);
      const result = await this.client.msearch(chunk);
      responses.push(...result.body.responses);
    }
    return responses;
  }

  async recomputeScores(): Promise<RecomputeResult> {
    // Phase 1: Drain in-memory pending dirty sets and fetch the
    // corresponding events from OpenSearch. By now these documents have
    // been through multiple natural refresh cycles and are searchable.
    const pending = this.drainPendingDirty();

    if (pending.ids.size === 0 && pending.pubkeys.size === 0) {
      return { count: 0, userScores: new Map(), eventScores: new Map() };
    }

    type DirtyHit = { id: string; kind: number; pubkey: string };
    const searches: Promise<DirtyHit[]>[] = [];

    // (a) Events referenced by engagement events (by event ID).
    // Exclude replaced (historical) versions — scores only apply to the
    // current version of each event.
    if (pending.ids.size > 0) {
      searches.push(
        this.client
          .search<DirtyHit>({
            index: this.indexName,
            body: {
              query: {
                bool: {
                  must: [{ terms: { id: [...pending.ids] } }],
                  must_not: [{ term: { replaced: true } }],
                },
              },
              _source: ["id", "kind", "pubkey"],
              size: pending.ids.size,
            },
          })
          .then((r) => {
            return r.body.hits.hits.flatMap((h) =>
              h._source?.id ? [h._source] : [],
            );
          }),
      );
    }

    // (b) Kind 0 profiles for followed pubkeys from contact lists.
    if (pending.pubkeys.size > 0) {
      searches.push(
        this.client
          .search<DirtyHit>({
            index: this.indexName,
            body: {
              query: {
                bool: {
                  must: [
                    { term: { kind: 0 } },
                    { terms: { pubkey: [...pending.pubkeys] } },
                  ],
                  must_not: [{ term: { replaced: true } }],
                },
              },
              _source: ["id", "kind", "pubkey"],
              size: pending.pubkeys.size,
            },
          })
          .then((r) => {
            return r.body.hits.hits.flatMap((h) =>
              h._source?.id ? [h._source] : [],
            );
          }),
      );
    }

    const results = await Promise.all(searches);

    // Merge and deduplicate all dirty hits.
    const seen = new Set<string>();
    const dirtyKind0: Array<{ id: string; pubkey: string }> = [];
    const dirtyNonKind0Ids: string[] = [];

    for (const hits of results) {
      for (const hit of hits) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        if (hit.kind === 0) {
          dirtyKind0.push({ id: hit.id, pubkey: hit.pubkey });
        } else {
          dirtyNonKind0Ids.push(hit.id);
        }
      }
    }

    // Cap the expensive (6-sub-query) engagement work per tick; return the
    // overflow to the pending set so it drains over subsequent ticks rather
    // than blocking the loop in one spike. See
    // MAX_RECOMPUTE_ENGAGEMENT_PER_TICK.
    if (dirtyNonKind0Ids.length > MAX_RECOMPUTE_ENGAGEMENT_PER_TICK) {
      const overflow = dirtyNonKind0Ids.splice(
        MAX_RECOMPUTE_ENGAGEMENT_PER_TICK,
      );
      this.addDirtyIds(overflow);
    }

    const allDirtyIds = [...dirtyKind0.map((d) => d.id), ...dirtyNonKind0Ids];

    if (allDirtyIds.length === 0) {
      return { count: 0, userScores: new Map(), eventScores: new Map() };
    }

    // Build score maps — initialize all dirty IDs with zeros.
    const scores = new Map<string, Scores>();

    for (const id of allDirtyIds) {
      scores.set(id, zeroScores());
    }

    // Phase 2a: Compute follower counts for dirty kind 0 events.
    // Uses per-pubkey count queries via msearch to avoid expensive global
    // ordinal builds on the high-cardinality tags_map.p field.
    if (dirtyKind0.length > 0) {
      const followerSearches = dirtyKind0.map(({ pubkey }) => ({
        index: this.indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { term: { kind: 3 } },
                { term: { "tags_map.p": pubkey } },
              ],
            },
          },
          size: 0,
          track_total_hits: true,
        },
      }));

      const followerResponses = await this.msearchChunked(followerSearches);

      for (let i = 0; i < dirtyKind0.length; i++) {
        const s = scores.get(dirtyKind0[i].id);
        if (!s) continue;
        const resp = followerResponses[i];
        s.followers = resp?.hits?.total?.value ?? 0;
      }
    }

    // Phase 2b+3+3b: Compute engagement scores for dirty non-kind-0 events.
    // Uses per-event-ID queries via msearch to avoid expensive global ordinal
    // builds on the high-cardinality tags_map.e field. For each dirty event
    // ID, we issue 6 small queries:
    //   0: comment count (kinds 1, 1111 via tags_map.e)
    //   1: reaction count (kind 7 via tags_map.e)
    //   2: repost count (kinds 6, 16 via tags_map.e)
    //   3: zap count + amount (kind 9735 via tags_map.e, with sum agg)
    //   4: quote count (kind 1 via tags_map.q)
    //   5: unique engagers (all engagement kinds via tags_map.e, cardinality agg)
    // When a trust provider is active, the same six queries are issued but
    // each returns a per-pubkey terms agg instead, and only trusted
    // authors contribute to the counts.
    if (dirtyNonKind0Ids.length > 0) {
      const QUERIES_PER_EVENT = ENGAGEMENT_QUERIES.length;
      const baseMust = [
        { term: { deleted: false } },
        { term: { replaced: false } },
      ];

      // Trusted (WoT) mode: instead of reading hit counts, each sub-query
      // returns a per-pubkey terms agg so the readout below can count only
      // trusted authors. The zap sub-query nests its amount sum per pubkey
      // for the same reason.
      const trusted = this.trustProvider?.();

      const engagementSearches: Array<{ index: string; body: unknown }> = [];

      for (const eventId of dirtyNonKind0Ids) {
        for (const q of ENGAGEMENT_QUERIES) {
          engagementSearches.push({
            index: this.indexName,
            body: {
              query: {
                bool: {
                  must: [
                    ...baseMust,
                    { terms: { kind: q.kinds } },
                    { term: { [`tags_map.${q.tag}`]: eventId } },
                  ],
                },
              },
              size: 0,
              ...(trusted
                ? {
                    aggs: {
                      by_pubkey: {
                        terms: {
                          field: "pubkey",
                          size: TRUSTED_PUBKEY_AGG_SIZE,
                          // Each sub-query matches only the handful of docs
                          // referencing one target event, so build the term
                          // map from those docs directly. The default
                          // (global_ordinals) would build ordinals over every
                          // pubkey in the shard — catastrophic on this
                          // ultra-high-cardinality field, and the exact cost
                          // the count/cardinality design originally avoided.
                          execution_hint: "map",
                        },
                        ...("agg" in q &&
                          q.agg.into === "zap_amount_msats" && {
                            aggs: { total_msats: q.agg.body },
                          }),
                      },
                    },
                  }
                : {
                    // Only queries whose hit count is read need an exact total.
                    ...(q.field !== undefined && { track_total_hits: true }),
                    ...("agg" in q && { aggs: { [q.agg.name]: q.agg.body } }),
                  }),
            },
          });
        }
      }

      const responses = await this.msearchChunked(engagementSearches);

      for (let i = 0; i < dirtyNonKind0Ids.length; i++) {
        const s = scores.get(dirtyNonKind0Ids[i]);
        if (!s) continue;

        const base = i * QUERIES_PER_EVENT;

        ENGAGEMENT_QUERIES.forEach((q, j) => {
          const resp: MsearchResponseItem | undefined = responses[base + j];
          if (trusted) {
            // Count only buckets whose pubkey is in the trusted set. The
            // engagers entry counts trusted bucket keys (unique authors);
            // everything else sums doc counts (events) over them.
            const aggs = resp?.aggregations as
              | { by_pubkey?: { buckets?: PubkeyBucket[] } }
              | undefined;
            const buckets = (aggs?.by_pubkey?.buckets ?? []).filter((b) =>
              trusted.has(b.key),
            );
            if (q.field !== undefined) {
              s[q.field] = buckets.reduce((sum, b) => sum + b.doc_count, 0);
            }
            if ("agg" in q) {
              s[q.agg.into] =
                q.agg.into === "engagers"
                  ? buckets.length
                  : buckets.reduce(
                      (sum, b) => sum + (b.total_msats?.value ?? 0),
                      0,
                    );
            }
          } else {
            if (q.field !== undefined) {
              s[q.field] = resp?.hits?.total?.value ?? 0;
            }
            if ("agg" in q) {
              const aggs = resp?.aggregations as
                | Record<string, { value?: number } | undefined>
                | undefined;
              s[q.agg.into] = aggs?.[q.agg.name]?.value ?? 0;
            }
          }
        });
      }
    }

    // Phase 4: Bulk update the dirty events with computed scores.
    //
    // Write back only the fields this phase actually computed for the
    // document's kind: `followers` comes from Phase 2a and applies to kind 0
    // profiles, the engagement fields come from Phase 2b and apply to
    // everything else. Writing the full set for every document meant each
    // recompute overwrote a kind 0 doc's engagement counts with zeros (Phase
    // 2b skips kind 0) and every other doc's `followers` with zero.
    const kind0Ids = new Set(dirtyKind0.map((d) => d.id));
    const body: Array<Record<string, unknown>> = [];

    for (const [id, s] of scores) {
      const fields = kind0Ids.has(id)
        ? PROFILE_SCORE_FIELDS
        : ENGAGEMENT_SCORE_FIELDS;

      body.push({
        update: {
          _index: this.indexName,
          _id: id,
        },
      });
      body.push({
        doc: Object.fromEntries(fields.map((f) => [f, s[f]])),
      });
    }

    if (body.length > 0) {
      const updateResponse = await this.writeClient.bulk({
        body,
        refresh: false,
      });

      // Some bulk updates may still fail for unexpected reasons.
      if (updateResponse.body.errors) {
        const items: Array<
          Record<string, { error?: unknown; status?: number }>
        > = updateResponse.body.items;

        for (let i = 0; i < items.length; i++) {
          const result = items[i].update;
          if (result?.error) {
            this.log.warn("score_update_failed", {
              err: JSON.stringify(result.error),
            });
          }
        }
      }
    }

    const kind0Count = dirtyKind0.length;
    const nonKind0Count = dirtyNonKind0Ids.length;
    this.log.debug("scores_recomputed", {
      count: allDirtyIds.length,
      profiles: kind0Count,
      engagement: nonKind0Count,
    });

    // Build result maps for callers (e.g. NIP-85 publisher).
    const userScores = new Map<string, { followers: number }>();
    for (const { id, pubkey } of dirtyKind0) {
      const s = scores.get(id);
      if (s) {
        userScores.set(pubkey, { followers: s.followers });
      }
    }

    const eventScores = new Map<string, EventScores>();
    for (const id of dirtyNonKind0Ids) {
      const s = scores.get(id);
      if (s) {
        eventScores.set(id, {
          comment_cnt: s.comment_cnt,
          reaction_cnt: s.reaction_cnt,
          repost_cnt: s.repost_cnt,
          quote_cnt: s.quote_cnt,
          zap_amount_msats: s.zap_amount_msats,
          zap_cnt: s.zap_cnt,
        });
      }
    }

    return { count: allDirtyIds.length, userScores, eventScores };
  }

  /**
   * Queue the most-engaged recent events for score recomputation.
   *
   * Called by the background worker after the first WoT refresh so that
   * scores computed before trust filtering was active are recomputed under
   * it — otherwise an already-boosted sybil post would keep its inflated
   * `engagers` until its next organic engagement re-dirties it. Bounded to
   * the decay-sort window (older events score ~0 in sort:hot anyway) and
   * to the top `max` by `engagers`, which covers everything that could
   * surface in a sorted view.
   */
  async seedDirtyEngaged(max = 2000): Promise<number> {
    const now = Math.floor(Date.now() / 1000);

    const response = await this.client.search<{ id: string }>({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { term: { replaced: false } },
              {
                range: {
                  created_at: { gte: now - DECAY_SORT_WINDOW_SECONDS },
                },
              },
              { range: { engagers: { gt: 0 } } },
            ],
          },
        },
        sort: [{ engagers: { order: "desc" as const } }],
        _source: ["id"],
        size: max,
      },
    });

    const ids = response.body.hits.hits.flatMap((h) =>
      h._source?.id ? [h._source.id] : [],
    );
    this.addDirtyIds(ids);
    return ids.length;
  }

  /**
   * Flush remaining events and close the OpenSearch connection(s).
   */
  async close(): Promise<void> {
    await this.flush();
    await this.client.close();
    if (this.writeClient !== this.client) {
      await this.writeClient.close();
    }
  }

  /**
   * Dispose resources
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
