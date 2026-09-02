import type { NostrSigner } from "@nostrify/nostrify";
import { NSecSigner } from "@nostrify/nostrify";
import { nip19 } from "nostr-tools";

import type { LogLevel } from "./log.ts";
import { DEFAULT_NSFW_HASHTAGS } from "./nsfw.ts";

export class Config {
  readonly port: number;
  /** Minimum log level to emit: `debug` | `info` | `warn` | `error` (default: `info`). */
  readonly logLevel: LogLevel;
  /**
   * HTTP header carrying the real client IP, for deployments behind a
   * reverse proxy (e.g. `CF-Connecting-IP` behind Cloudflare, `X-Real-IP`
   * or `X-Forwarded-For` behind nginx). For comma-separated values the
   * first entry is used. When unset, the socket's remote address is used —
   * correct for direct (un-proxied) deployments. Only set this to a header
   * your proxy strips/overwrites; otherwise clients can spoof it.
   */
  readonly ipHeader: string | undefined;
  readonly relayUrl: string;
  readonly publicUrl: string;
  readonly relayPubkey: string | undefined;
  readonly relayContact: string | undefined;
  readonly opensearchNode: string;
  readonly opensearchIndex: string;
  readonly opensearchUsername: string | undefined;
  readonly opensearchPassword: string | undefined;
  /** Comma-separated list of ISO 639-1 language codes for per-language trends. */
  readonly preferredLanguages: string[];
  /** Interval in ms between trend computations. 0 to disable. Default: 15 minutes. */
  readonly trendsIntervalMs: number;
  /** Whether to preserve historical versions of replaceable/addressable events. Default: true. */
  readonly historyEnabled: boolean;
  /**
   * Set of kind numbers to preserve history for.
   * When set, ONLY these kinds will have history preserved (whitelist mode).
   * Takes precedence over `historyKindsExcluded`.
   */
  readonly historyKindsWhitelist: Set<number> | undefined;
  /**
   * Set of kind numbers to exclude from history preservation.
   * Ignored when `historyKindsWhitelist` is set.
   * Default: 30382,30383,30384,30385 (NIP-85 record events).
   */
  readonly historyKindsExcluded: Set<number>;
  /**
   * Set of kind numbers that require AUTH for REQ/COUNT queries.
   * Filters including these kinds must have `authors` or `#p` arrays where ALL
   * entries are authenticated pubkeys on the connection.
   * These kinds are also excluded from queries that don't explicitly include them.
   * Default: 4,1059 (NIP-04 DMs and NIP-59 Gift Wraps).
   */
  readonly authKinds: Set<number>;
  /**
   * Subset of `authKinds` that a REQ/COUNT/NEG-OPEN filter may read WITHOUT
   * NIP-42 when it names a non-empty `authors` list (and every auth kind in
   * the filter is in this set). Meant for kinds authored by unguessable
   * ephemeral or derived pubkeys rather than user identities — NIP-59 gift
   * wraps (kind 1059): knowing the wrap author to ask for is itself the read
   * capability, and readers of write-restricted streams (e.g. Concord's
   * staff-signed control plane) hold the address without its secret, so they
   * can never authenticate as it. `#p`-scoped and unscoped queries stay
   * auth-gated. Set via `AUTH_AUTHOR_EXEMPT_KINDS`. Default: 1059.
   */
  readonly authorExemptKinds: Set<number>;
  /**
   * Set of pubkeys (hex) granted unconditional read access to auth-protected
   * kinds. A connection that authenticates (NIP-42) as any of these pubkeys
   * bypasses all AUTH gating and can read every user's auth-kind events
   * (e.g. DMs, gift wraps) via REQ/COUNT/NEG-OPEN — including catch-all
   * filters and live subscriptions. Intended for operator-controlled services
   * such as bridges and notification servers. Set via the `MASTER_PUBKEYS`
   * env var (comma-separated hex pubkeys). Default: empty (no master pubkeys).
   */
  readonly masterPubkeys: Set<string>;
  /**
   * Seed pubkeys (hex) for the engagement web of trust. The background
   * worker expands these 2 follow-hops via kind 3 contact lists; only
   * pubkeys inside the resulting set count toward `engagers`, the other
   * engagement scores, and trends. Distinct from `MASTER_PUBKEYS` (infra
   * service keys for AUTH bypass, with no meaningful follow graphs): seeds
   * should be real accounts whose follows root the trust graph, e.g. the
   * operator's personal account. Set via the `WOT_SEED_PUBKEYS` env var
   * (comma-separated hex pubkeys). Default: empty (trust filtering
   * disabled — every pubkey counts).
   */
  readonly wotSeedPubkeys: Set<string>;
  /** Whether to enable background stats recomputation and NIP-85 publishing. Default: true. */
  readonly statsEnabled: boolean;
  /**
   * Maximum size (in bytes) of a single inbound WebSocket message.
   * Used both as Bun's `maxPayloadLength` (enforcement) and as NIP-11
   * `limitation.max_message_length` (advertisement) — single source of truth.
   * Default: 4_000_000 (4 MB).
   */
  readonly maxMessageLength: number;
  /**
   * Maximum number of entries in any single filter array (`ids`, `authors`,
   * `kinds`, or any `#<tag>`). Caps the fan-out of per-filter OpenSearch
   * `terms` clauses. Default: 20000.
   */
  readonly maxFilterValues: number;
  /**
   * Default number of events returned for a REQ filter that omits `limit`.
   * Applied to incoming REQ filters by the relay. Default: 100.
   */
  readonly defaultLimit: number;
  /**
   * Maximum number of events returned for a single REQ filter, regardless of
   * the client-supplied `limit`. Applied to incoming REQ filters by the relay
   * and advertised to clients as NIP-11 `limitation.max_limit` so the
   * advertised value matches what is enforced. Default: 1000.
   */
  readonly maxLimit: number;
  /**
   * Maximum number of values stored per tag name in the indexed `tags_map`
   * projection. Bounds the per-document inverted-index growth from events
   * with very high tag counts. Also surfaced to clients as NIP-11
   * `limitation.max_event_tags`: events with more tags of the same name
   * are still accepted and stored verbatim, but values beyond this count
   * are dropped from the searchable projection. Default: 5000.
   */
  readonly tagValueMaxCountPerName: number;
  /**
   * Maximum size of the OpenSearch bulk indexing queue before
   * `relay.storage.event(...)` rejects new events with `error: relay
   * overloaded`. Default: 5_000.
   */
  readonly bulkMaxQueue: number;
  /**
   * Maximum number of in-flight `handleEvent` Promises per WebSocket
   * connection. EVENT messages over the cap wait their turn via a
   * per-connection semaphore. Prevents one firehose client from flooding
   * the main thread's microtask queue and starving REQs from other
   * connections. Default: 32.
   */
  readonly maxInflightPerConn: number;
  /**
   * Set of banned hashtags (lowercased `t` tag values). Events containing any
   * `t` tag whose value matches an entry are rejected at ingestion.
   * Comma-separated, case-insensitive. Default: empty (no hashtags banned).
   */
  readonly bannedHashtags: Set<string>;
  /**
   * Set of NSFW hashtags (lowercased `t` tag values). An event carrying both
   * a media attachment and any of these hashtags is indexed with `nsfw: true`
   * and can be excluded from search results with the NIP-50 `nsfw:false`
   * extension token. Comma-separated, case-insensitive. Set to an empty value
   * to disable NSFW classification. Default: see `DEFAULT_NSFW_HASHTAGS` in
   * nsfw.ts.
   */
  readonly nsfwHashtags: Set<string>;
  /**
   * Whether to reject NSFW events at ingestion instead of merely indexing
   * them with `nsfw: true`. Matching events get an `OK: false` reply with a
   * `blocked:` message and are never stored. Classification is unchanged —
   * it still requires both a media attachment and a hashtag from
   * `nsfwHashtags`, so an empty `NSFW_HASHTAGS` disables this too.
   * Default: false (classify but accept).
   */
  readonly rejectNsfw: boolean;
  /**
   * Set of kind numbers that are rejected at ingestion regardless of any
   * other policy. Events matching these kinds get an `OK: false` reply with
   * a `blocked:` message and are never stored. Comma-separated.
   *
   * Default: signed artifacts that are never meant to be published to a relay
   * as standalone events:
   *   - 13    NIP-59 seal (inner layer, only valid wrapped in a gift wrap)
   *   - 9734  NIP-57 zap request (sent to the LNURL callback, not relays)
   *   - 20013 Concord encrypted seal (inner layer, only valid wrapped in a
   *           gift wrap; CORD-01)
   *   - 20014 Concord plaintext seal (inner layer, only valid wrapped in a
   *           gift wrap; CORD-01)
   *   - 22242 NIP-42 client auth (carried only in `["AUTH", ...]` frames)
   *   - 24242 Blossom (NIP-B7) blob auth (HTTP `Authorization` header artifact)
   *   - 27235 NIP-98 HTTP auth (HTTP `Authorization` header artifact)
   *
   * Note: NWC (23194/23195, NIP-47) and Nostr Connect (24133, NIP-46) look
   * similar but intentionally use a relay as a transport channel, so they are
   * NOT rejected. Likewise the 9735 zap receipt and 1059 gift wrap ARE meant
   * to be published and are not rejected.
   */
  readonly rejectedKinds: Set<number>;
  /**
   * Maximum number of records a single NIP-77 NEG-OPEN sync may cover.
   * Queries matching more records are rejected with `NEG-ERR blocked:`.
   * Each record costs ~40 bytes of session memory while the sync is open.
   * Default: 1_000_000.
   */
  readonly negentropyMaxRecords: number;
  /**
   * Number of protocol worker threads that own connection state and message
   * handling (parse, validate, verify, query, frame building). The main
   * thread only routes raw strings between sockets and workers.
   *
   * - unset → auto: `max(1, min(16, floor(hardwareConcurrency / 4)))`,
   *   resolved by the protocol pool.
   * - `N`  → exactly N workers (must be >= 1).
   */
  readonly protocolWorkers: number | undefined;
  readonly nostrSigner: NostrSigner;

  constructor(env: { get(key: string): string | undefined }) {
    // port
    const portValue = env.get("PORT");
    if (!portValue) {
      this.port = 13131;
    } else {
      const port = parseInt(portValue, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be a valid port number (1-65535).");
      }
      this.port = port;
    }

    // logLevel
    const logLevelValue = env.get("LOG_LEVEL");
    if (!logLevelValue) {
      this.logLevel = "info";
    } else {
      const lower = logLevelValue.toLowerCase();
      if (
        lower !== "debug" &&
        lower !== "info" &&
        lower !== "warn" &&
        lower !== "error"
      ) {
        throw new Error("LOG_LEVEL must be one of: debug, info, warn, error.");
      }
      this.logLevel = lower;
    }

    // ipHeader
    this.ipHeader = env.get("IP_HEADER") || undefined;

    // relayUrl
    const relayUrlValue = env.get("RELAY_URL");
    if (!relayUrlValue) {
      throw new Error("RELAY_URL is required.");
    }
    this.relayUrl = relayUrlValue;

    // publicUrl
    const publicUrlValue = env.get("PUBLIC_URL");
    this.publicUrl = publicUrlValue ?? this.relayUrl.replace(/^ws/, "http");

    // relayPubkey
    this.relayPubkey = env.get("RELAY_PUBKEY");

    // relayContact
    this.relayContact = env.get("RELAY_CONTACT");

    // opensearch
    this.opensearchNode = env.get("OPENSEARCH_NODE") || "http://localhost:9200";
    this.opensearchIndex = env.get("OPENSEARCH_INDEX") || "nostr-events";
    this.opensearchUsername = env.get("OPENSEARCH_USERNAME");
    this.opensearchPassword = env.get("OPENSEARCH_PASSWORD");

    // preferredLanguages
    const langValue = env.get("DITTO_LANGUAGES");
    if (!langValue) {
      this.preferredLanguages = [];
    } else {
      this.preferredLanguages = langValue
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[a-z]{2}$/.test(s));
    }

    // trendsIntervalMs
    const trendsValue = env.get("TRENDS_INTERVAL_MS");
    if (!trendsValue) {
      this.trendsIntervalMs = 900_000;
    } else {
      const ms = parseInt(trendsValue, 10);
      if (Number.isNaN(ms) || ms < 0) {
        throw new Error("TRENDS_INTERVAL_MS must be a non-negative integer.");
      }
      this.trendsIntervalMs = ms;
    }

    // historyEnabled
    const historyValue = env.get("HISTORY_ENABLED");
    if (!historyValue) {
      this.historyEnabled = true;
    } else {
      this.historyEnabled =
        historyValue.toLowerCase() === "true" || historyValue === "1";
    }

    // historyKindsWhitelist
    const whitelistValue = env.get("HISTORY_KINDS_WHITELIST");
    if (!whitelistValue) {
      this.historyKindsWhitelist = undefined;
    } else {
      const kinds = whitelistValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.historyKindsWhitelist =
        kinds.length > 0 ? new Set(kinds) : undefined;
    }

    // historyKindsExcluded
    const excludedValue = env.get("HISTORY_KINDS_EXCLUDED");
    if (excludedValue === undefined) {
      this.historyKindsExcluded = new Set([30382, 30383, 30384, 30385]);
    } else {
      const kinds = excludedValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.historyKindsExcluded = new Set(kinds);
    }

    // authKinds
    const authValue = env.get("AUTH_KINDS");
    if (authValue === undefined) {
      this.authKinds = new Set([4, 1059]);
    } else {
      const kinds = authValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.authKinds = new Set(kinds);
    }

    // authorExemptKinds
    const authorExemptValue = env.get("AUTH_AUTHOR_EXEMPT_KINDS");
    if (authorExemptValue === undefined) {
      this.authorExemptKinds = new Set([1059]);
    } else {
      const kinds = authorExemptValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.authorExemptKinds = new Set(kinds);
    }

    // masterPubkeys
    const masterPubkeysValue = env.get("MASTER_PUBKEYS");
    if (!masterPubkeysValue) {
      this.masterPubkeys = new Set();
    } else {
      const pubkeys = masterPubkeysValue
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
        .map((s) => {
          if (!/^[0-9a-f]{64}$/.test(s)) {
            throw new Error(
              `MASTER_PUBKEYS entries must be 64-character hex pubkeys; invalid entry: ${s}`,
            );
          }
          return s;
        });
      this.masterPubkeys = new Set(pubkeys);
    }

    // wotSeedPubkeys
    const wotSeedPubkeysValue = env.get("WOT_SEED_PUBKEYS");
    if (!wotSeedPubkeysValue) {
      this.wotSeedPubkeys = new Set();
    } else {
      const pubkeys = wotSeedPubkeysValue
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
        .map((s) => {
          if (!/^[0-9a-f]{64}$/.test(s)) {
            throw new Error(
              `WOT_SEED_PUBKEYS entries must be 64-character hex pubkeys; invalid entry: ${s}`,
            );
          }
          return s;
        });
      this.wotSeedPubkeys = new Set(pubkeys);
    }

    // statsEnabled
    const statsValue = env.get("STATS_ENABLED");
    if (!statsValue) {
      this.statsEnabled = true;
    } else {
      this.statsEnabled =
        statsValue.toLowerCase() === "true" || statsValue === "1";
    }

    // maxMessageLength
    const maxMsgValue = env.get("RELAY_MAX_MESSAGE_LENGTH");
    if (!maxMsgValue) {
      this.maxMessageLength = 4_000_000;
    } else {
      const bytes = parseInt(maxMsgValue, 10);
      if (Number.isNaN(bytes) || bytes <= 0) {
        throw new Error(
          "RELAY_MAX_MESSAGE_LENGTH must be a positive integer (bytes).",
        );
      }
      this.maxMessageLength = bytes;
    }

    // maxFilterValues
    const maxFilterValuesValue = env.get("RELAY_MAX_FILTER_VALUES");
    if (!maxFilterValuesValue) {
      this.maxFilterValues = 20_000;
    } else {
      const n = parseInt(maxFilterValuesValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error("RELAY_MAX_FILTER_VALUES must be a positive integer.");
      }
      this.maxFilterValues = n;
    }

    // maxLimit
    const maxLimitValue = env.get("RELAY_MAX_LIMIT");
    if (!maxLimitValue) {
      this.maxLimit = 1000;
    } else {
      const n = parseInt(maxLimitValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error("RELAY_MAX_LIMIT must be a positive integer.");
      }
      this.maxLimit = n;
    }

    // defaultLimit
    const defaultLimitValue = env.get("RELAY_DEFAULT_LIMIT");
    if (!defaultLimitValue) {
      this.defaultLimit = 100;
    } else {
      const n = parseInt(defaultLimitValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error("RELAY_DEFAULT_LIMIT must be a positive integer.");
      }
      this.defaultLimit = n;
    }
    if (this.defaultLimit > this.maxLimit) {
      throw new Error("RELAY_DEFAULT_LIMIT must not exceed RELAY_MAX_LIMIT.");
    }

    // tagValueMaxCountPerName
    const tagValueMaxCountPerNameValue = env.get(
      "RELAY_TAG_VALUE_MAX_COUNT_PER_NAME",
    );
    if (!tagValueMaxCountPerNameValue) {
      this.tagValueMaxCountPerName = 5000;
    } else {
      const n = parseInt(tagValueMaxCountPerNameValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error(
          "RELAY_TAG_VALUE_MAX_COUNT_PER_NAME must be a positive integer.",
        );
      }
      this.tagValueMaxCountPerName = n;
    }

    // bulkMaxQueue
    const bulkMaxQueueValue = env.get("BULK_MAX_QUEUE");
    if (!bulkMaxQueueValue) {
      this.bulkMaxQueue = 5_000;
    } else {
      const n = parseInt(bulkMaxQueueValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error("BULK_MAX_QUEUE must be a positive integer.");
      }
      this.bulkMaxQueue = n;
    }

    // maxInflightPerConn
    const maxInflightPerConnValue = env.get("RELAY_MAX_INFLIGHT_PER_CONN");
    if (!maxInflightPerConnValue) {
      this.maxInflightPerConn = 32;
    } else {
      const n = parseInt(maxInflightPerConnValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error(
          "RELAY_MAX_INFLIGHT_PER_CONN must be a positive integer.",
        );
      }
      this.maxInflightPerConn = n;
    }

    // bannedHashtags
    const bannedHashtagsValue = env.get("BANNED_HASHTAGS");
    if (!bannedHashtagsValue) {
      this.bannedHashtags = new Set();
    } else {
      const tags = bannedHashtagsValue
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
      this.bannedHashtags = new Set(tags);
    }

    // nsfwHashtags: unset = defaults; explicitly empty = classification off.
    const nsfwHashtagsValue = env.get("NSFW_HASHTAGS");
    if (nsfwHashtagsValue === undefined) {
      this.nsfwHashtags = new Set(DEFAULT_NSFW_HASHTAGS);
    } else {
      const tags = nsfwHashtagsValue
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
      this.nsfwHashtags = new Set(tags);
    }

    // rejectNsfw
    const rejectNsfwValue = env.get("REJECT_NSFW");
    this.rejectNsfw =
      rejectNsfwValue?.toLowerCase() === "true" || rejectNsfwValue === "1";

    // rejectedKinds
    const rejectedKindsValue = env.get("REJECTED_KINDS");
    if (rejectedKindsValue === undefined) {
      this.rejectedKinds = new Set([
        13, 9734, 20013, 20014, 22242, 24242, 27235,
      ]);
    } else {
      const kinds = rejectedKindsValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.rejectedKinds = new Set(kinds);
    }

    // negentropyMaxRecords
    const negentropyMaxRecordsValue = env.get("RELAY_NEGENTROPY_MAX_RECORDS");
    if (!negentropyMaxRecordsValue) {
      this.negentropyMaxRecords = 1_000_000;
    } else {
      const n = parseInt(negentropyMaxRecordsValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error(
          "RELAY_NEGENTROPY_MAX_RECORDS must be a positive integer.",
        );
      }
      this.negentropyMaxRecords = n;
    }

    // protocolWorkers: unset = auto (resolved by the pool), else exactly N.
    const protocolWorkersValue = env.get("PROTOCOL_WORKERS");
    if (protocolWorkersValue === undefined || protocolWorkersValue === "") {
      this.protocolWorkers = undefined;
    } else {
      const n = parseInt(protocolWorkersValue, 10);
      if (Number.isNaN(n) || n < 1) {
        throw new Error("PROTOCOL_WORKERS must be a positive integer.");
      }
      this.protocolWorkers = n;
    }

    // nostrSigner
    const nsecValue = env.get("NOSTR_NSEC");
    if (!nsecValue) {
      throw new Error("NOSTR_NSEC is required.");
    }
    const decoded = nip19.decode(nsecValue);
    if (decoded.type !== "nsec") {
      throw new Error(
        "NOSTR_NSEC must be a valid nsec (bech32-encoded secret key).",
      );
    }
    this.nostrSigner = new NSecSigner(decoded.data);
  }
}
