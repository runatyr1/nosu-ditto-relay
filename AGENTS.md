# Project Details

## Features

- **NIP-01 Relay**: True WebSocket-based Nostr relay implementation
- **Bun Runtime**: Uses Bun's native WebSocket server for high performance
- **Multi-threaded**: Protocol workers own connections and per-message work;
  the main thread only routes strings between sockets and workers
- **OpenSearch Backend**: Scalable event storage and querying
- **Validation**: Zod and Nostrify for event validation
- **Environment Config**: Type-safe configuration management
- **Portable Code**: Uses Node.js builtins for maximum compatibility (except WebSocket server)

## Architecture

The relay is multi-threaded around one rule: **the main thread only moves
strings**. It never parses, validates, serializes, or queries.

```
                     ┌─ protocol worker 0..N-1 (protocol-worker.ts)
 Bun.serve (main)    │    per-conn state: subs, auth, negentropy
  upgrade/close ─────┤    parse + zod + verify/analyze (inline)
  raw msg strings ──►│    OpenSearch reads (own read client)
  frame strings ◄────┤    broadcast matching + frame building
  ws.send only       │         │ MessageChannel (writes)
                     └─────────▼
                      indexer worker (indexer-worker.ts)
                        bulk queue/flush, phase-2 slot resolution,
                        dirty tracking → background stats worker
```

- **Main thread** (`server.ts` + `protocol-pool.ts`): HTTP endpoints
  (NIP-11 cached as a string, /metrics aggregation), WebSocket upgrade,
  sticky least-connections assignment of connections to protocol workers,
  batched string forwarding in both directions, accepted-event fan-out to
  sibling workers, worker supervision (a dead worker's connections are
  closed with 1011 and the slot respawns; clients reconnect; repeated
  deaths within 30s trip a crash-loop guard that exits the process so
  systemd restarts it with real backoff).
- **Protocol workers** (`protocol-worker.ts`): a full `Relay` instance each.
  All per-message CPU lives here, including inline signature verification
  and language/sentiment/media analysis (`analyze.ts`) — no extra thread
  hop per EVENT.
- **Indexer worker** (`indexer-worker.ts`): owns all writes on the ingest
  path. Protocol workers RPC to it over dedicated MessageChannel ports
  (`indexer-client.ts`), bypassing the main thread; bulk batches stay
  coalesced and replaceable-slot resolution has one writer. `event()`
  resolves on bulk-flush confirmation, so OK responses reflect durability.
- **Background stats worker** (`background-worker.ts`): score
  recomputation, NIP-85, trends. Fed dirty references by the indexer via
  main; its published events are injected into all protocol workers for
  broadcast. Note it holds its own OpenSearch write client and publishes
  30382/30383 and trend labels directly rather than through the indexer,
  so the indexer is not literally the only writer in the process — those
  kinds bypass its slot serialization.

The seam that makes this work is `RelayConn` (relay.ts): the Relay only
sees `{id, data, send(frame)}` and emits finished NIP-01 frames as strings.
Strings cross thread boundaries as flat copies — no object-graph clones on
the hot path.

## Project Structure

```
.
├── src/
│   ├── server.ts           # Entry point: Bun.serve, HTTP, mode wiring (Bun-specific)
│   ├── protocol-pool.ts    # Main-thread bridge: worker spawn/routing/fan-out/supervision
│   ├── protocol-pool.test.ts # Pool integration tests (real workers, mock OpenSearch)
│   ├── protocol-worker.ts  # Protocol worker: connections + all per-message work
│   ├── indexer-worker.ts   # Indexer worker: owns writes on the ingest path
│   ├── indexer-client.ts   # Write-RPC client + port protocol (used in protocol workers)
│   ├── worker-inbox.ts     # Buffers messages arriving before a worker installs its handler
│   ├── worker-inbox.test.ts # Worker inbox buffering tests
│   ├── relay.ts            # Relay implementation (event handling, subscriptions)
│   ├── relay.test.ts       # Relay tests
│   ├── opensearch.ts       # OpenSearch backend (storage, querying, NIP-50)
│   ├── opensearch.test.ts  # OpenSearch tests
│   ├── config.ts           # Configuration management
│   ├── config.test.ts      # Configuration tests
│   ├── analyze.ts          # Shared analyzer: verify, language, sentiment, media, spam
│   ├── analyze.test.ts     # Analyzer tests (spam-scoring scope)
│   ├── background-worker.ts # Stats/NIP-85/trends worker
│   ├── log.ts              # Structured JSON logging (one-line entries, Loki-queryable)
│   ├── log.test.ts         # Logging tests
│   ├── metrics.ts          # Prometheus metrics + multi-thread exposition merging
│   ├── metrics.test.ts     # Metrics merging tests
│   ├── media.ts            # Media/video detection from imeta tags and URLs
│   ├── media.test.ts       # Media detection tests
│   ├── errors.ts           # Typed ingest-backpressure errors (StorageOverloaded)
│   ├── expiration.ts       # NIP-40 expiry check shared by relay and storage
│   ├── expiration.test.ts  # Expiration tests
│   ├── landing-page.ts     # HTML landing page served on GET /
│   ├── landing-page.test.ts # Landing page tests
│   ├── nip85.ts            # NIP-85 Trusted Assertions publisher (kinds 30382-30385)
│   ├── nip85.test.ts       # NIP-85 tests
│   ├── nsfw.ts             # NSFW classification (media + NSFW hashtag) for NIP-50 nsfw:
│   ├── nsfw.test.ts        # NSFW classification tests
│   ├── nspam/              # Reply-spam classifier (barrydeen/nspam v2.4, MIT)
│   │   ├── index.ts        # NSpamClassifier, isScorable, content cap
│   │   ├── features.ts     # Hashed char/word n-grams + structural features
│   │   ├── preprocess.ts   # NFKC, invisible-char strip, URL/whitespace normalization
│   │   ├── murmur3.ts      # MurmurHash3 x86_32 (sklearn HashingVectorizer)
│   │   ├── lightgbm.ts     # Tree walker, packed-model codec, structural validation
│   │   ├── model.bin       # Packed model (856 KB; regenerate with scripts/pack-nspam.ts)
│   │   ├── fixtures/       # Upstream hash + parity fixtures, used as the port's oracle
│   │   └── nspam.test.ts   # Bit-parity tests against both fixture files
│   ├── opensearch-client.ts      # Fetch-based OpenSearch client used across src/
│   ├── opensearch-client.test.ts # OpenSearch client tests
│   ├── negentropy.ts       # NIP-77 Negentropy protocol codec (set reconciliation)
│   ├── negentropy.test.ts  # Negentropy tests
│   ├── pow.ts              # NIP-13 proof-of-work difficulty calculation
│   ├── pow.test.ts         # Proof-of-work tests
│   ├── search-text.ts      # Shared buildSearchText for full-text search indexing
│   ├── search-text.test.ts # Search text tests
│   ├── autocomplete-text.ts      # Shared buildAutocompleteText for edge-ngram autocomplete indexing
│   ├── autocomplete-text.test.ts # Autocomplete text tests
│   ├── trends.ts           # Trending tag computation and publishing
│   ├── trends.test.ts      # Trends tests
│   ├── wot.ts              # Web-of-trust set from kind 3 follow graphs
│   └── wot.test.ts         # WoT tests
├── scripts/
│   ├── analyze-client.ts          # Analyze a client's users (active/inactive, engagement, cohorts)
│   ├── backfill-client-address.ts # Backfill client field (NIP-89 client address) for existing events
│   ├── backfill-followers.ts      # Aggregate kind 3 p-tags into the followers field on kind 0 docs
│   ├── backfill-nsfw.ts           # Backfill the nsfw field for pre-existing events
│   ├── backfill-scores.ts         # Recompute engagement/zap/quote score fields from tags_map.e
│   ├── backfill-spam.ts           # Score pre-existing replies with nspam (needs the model, not Painless)
│   ├── pack-nspam.ts              # Repack upstream nspam model.txt + calibration.npz into model.bin
│   ├── delete-events.ts           # Delete events matching a NIP-01 filter
│   ├── delete-expired-events.ts   # Delete expired events (NIP-40)
│   ├── export.ts                  # Export events from the index
│   ├── painless.ts                # Shared library: generates Painless scripts from src/ rules
│   ├── refresh-nip85.ts           # Refresh NIP-85 stats for events matching a filter
│   ├── reindex-tags-map.ts        # Reindex tags_map for existing documents
│   ├── reindex-to-clean-index.ts  # Reindex into a fresh index
│   └── update-trends.ts           # Compute and publish trending tags
├── package.json       # Dependencies and scripts
├── tsconfig.json      # TypeScript configuration
├── biome.json         # Biome linter/formatter configuration
├── Dockerfile         # Container image (Bun runtime, no build step)
├── docker-compose.yml # Self-host stack: relay + single-node OpenSearch
├── .dockerignore      # Build context exclusions
├── .gitlab-ci.yml     # GitLab CI pipeline (lint, test, typecheck)
├── .env.example       # Example environment variables
├── .gitignore         # Git ignore rules
├── AGENTS.md          # Project documentation for AI agents
├── README.md          # Project documentation
└── LICENSE            # AGPL-3.0 license
```

## Configuration

Edit `.env` to configure the application:

- `PORT` - Server port (default: 13131)
- `RELAY_URL` - Full WebSocket URL of the relay, eg `wss://relay.example.com/`
- `RELAY_PUBKEY` - Relay operator's public key (hex, for NIP-11)
- `RELAY_CONTACT` - Relay operator's contact (email or URL, for NIP-11)
- `IP_HEADER` - HTTP header carrying the real client IP behind a reverse
  proxy (e.g. `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`; first
  comma-separated entry is used). Unset = use the socket address.
- `LOG_LEVEL` - Log level: `debug` | `info` | `warn` | `error` (default: `info`).
  Logs are one-line JSON, queryable in Loki with `| json`. `debug` includes
  per-REQ/per-EVENT/per-connection traffic entries; `info` is reserved for
  infrequent lifecycle events.
- `OPENSEARCH_NODE` - OpenSearch endpoint (default: http://localhost:9200)
- `OPENSEARCH_INDEX` - Index name (default: nostr-events)
- `OPENSEARCH_USERNAME` - OpenSearch username (optional)
- `OPENSEARCH_PASSWORD` - OpenSearch password (optional)
- `RELAY_MAX_LIMIT` - Maximum events returned per REQ filter; applied to
  incoming REQ filters by the relay (`clampLimit` in `relay.ts`) and
  advertised as NIP-11 `max_limit` (default: 1000). The storage layer honors
  whatever `limit` a filter carries, so internal queries (deletions, e-tag
  lookups) are not bound by this client-facing policy.
- `RELAY_DEFAULT_LIMIT` - Events returned per REQ filter when `limit` is
  omitted; must not exceed `RELAY_MAX_LIMIT` (default: 100).
- `PROTOCOL_WORKERS` - Number of protocol worker threads. Unset = auto
  (`max(1, min(16, floor(cores / 4)))`); must be `>= 1` when set.
- `AUTH_KINDS` - Comma-separated kinds requiring NIP-42 AUTH for REQ/COUNT and
  excluded from unscoped queries (default: `4,78,1059,30078` — DMs, gift wraps,
  and NIP-78 application-specific data).
- `AUTH_AUTHOR_EXEMPT_KINDS` - Subset of `AUTH_KINDS` served WITHOUT
  authentication to filters naming a non-empty `authors` list (when every
  auth kind in the filter is exempt). For these kinds the author is an
  unguessable ephemeral/derived pubkey (NIP-59 gift wraps, Concord stream
  addresses), so knowing it is the read capability; `#p`-scoped and unscoped
  queries stay gated. Default: `1059`.
- `MASTER_PUBKEYS` - Comma-separated hex pubkeys. A
  connection that authenticates (NIP-42) as any of these gets unconditional
  read access to all `AUTH_KINDS` events for every user — bypassing all AUTH
  gating on REQ/COUNT/NEG-OPEN and live subscriptions, including catch-all
  filters.   Intended for operator-controlled services such as bridges and
  notification servers. Default: empty (no master pubkeys).
- `NSFW_HASHTAGS` - Comma-separated hashtags (lowercased `t` tag values)
  marking events as NSFW. An event carrying both a media attachment and any
  of these hashtags is indexed with `nsfw: true`; the NIP-50 `nsfw:false`
  extension excludes such events from search results (they are included by
  default per the NIP). Set to an empty string to disable classification.
  Default: the built-in set in `src/nsfw.ts` (~19 hashtags in broad general
  use as adult-content markers; tags with common non-adult usage and
  long-tail compounds are deliberately excluded). Run
  `scripts/backfill-nsfw.ts` after enabling — or after changing the set — on
  an existing index.
- `REJECT_NSFW` - `true`/`1` to reject NSFW events at ingestion (`OK false
  "blocked: this relay does not accept NSFW content"`) instead of storing
  them with `nsfw: true`. Uses the same classification as `NSFW_HASHTAGS`,
  so an empty hashtag set rejects nothing. Only affects new ingests —
  already-indexed NSFW events stay put. Default: `false`.
- `SPAM_THRESHOLD` - Raw nspam score in `[0, 1]` at or above which a kind 1
  reply is hidden. Scoring runs inline in the protocol workers
  (`analyze.ts` step 6), gated by `isScorable` to kind 1 replies (an `e` tag,
  no `q` tag) and all kind 1111 comments. Kind 1111 needs neither check: the
  kind is itself the reply marker, its root scope is often an address or a
  URL rather than an event id, and per NIP-22 a `q` tag on a comment is a
  citation rather than a quote-post. The model is trained on kind 1 replies
  only, so 1111 is an extrapolation — same content shape, but NIP-22's
  uppercase root tags inflate the `tag_other_count` feature. The score is
  stored per-event in `spam_score` and the threshold is applied at *query*
  time, so it can be retuned with a restart rather than a reindex.

  Exclusion covers discovery-shaped filters only: anything not naming `ids`
  or `authors`, including `#e` thread views and `#p` notifications. Three
  internal read paths opt out explicitly in `buildQuery` — `remove` (spam
  must stay deletable), `queryIdsBatch`, and `queryItems` (NIP-77 sync must
  reflect what is stored, or peers re-offer forever). The NIP-50
  `include:spam` token opts out per query.

  **Stored value is the model's raw score, not its calibrated one.** The
  calibration table has four knots and clips ~92% of real notes to exactly 0
  or 1, so thresholding the calibrated score is not meaningfully tunable —
  0.7 and 0.9 differed by 2 notes in 612. See `SpamScore` in
  `nspam/index.ts`.

  **Filtering is stored-query only.** Live post-EOSE broadcast is not
  filtered: `broadcastOne` matches raw `NostrEvent`s and the worker fan-out
  is a bare `JSON.stringify(event)`, so the score does not cross that seam.
  A client with an open subscription still receives flagged replies live.

  A document with no `spam_score` is *unscored*, not clean — a `range` query
  never matches a missing field, so pre-backfill events and non-replies are
  always returned. Run `scripts/backfill-spam.ts` on an existing index.
  `0` disables everything (no model load, no scoring, no query clause).
  Default: `0.99`.
- `WOT_SEED_PUBKEYS` - Comma-separated hex pubkeys seeding the engagement
  web of trust. The background worker expands them 2 follow-hops via kind 3
  contact lists in the local index (hourly); while the set is available,
  only pubkeys inside it count toward engagement scores (`engagers`,
  comment/reaction/repost/quote/zap counts — the inputs to `sort:hot`,
  `sort:top`, etc.) and trending aggregations, so sybil swarms can't farm
  hot posts or trends. Seeds should be real accounts with meaningful follow
  graphs (e.g. the operator's personal account) — NOT the `MASTER_PUBKEYS`
  service keys, which exist only for AUTH bypass. Kind 0 `followers` counts
  are not filtered. Default: empty (no trust filtering; every pubkey
  counts).

## Performance Notes

These are implemented, not aspirations — check them before adding a
parallel mechanism:

- **Broadcast filter index** (`relay.ts`): live subscriptions are indexed
  by kind (`kindIndex`) plus a `catchAll` set, so an incoming event is
  matched against candidate filters rather than every subscription.
- **Budgeted broadcast drain** (`relay.ts`): queued broadcasts are drained
  in batches bounded by a 5ms budget with a `setTimeout(0)` between
  batches, so REQ handlers interleave instead of queueing behind a burst.
- **Split read/write clients** (`opensearch.ts`): reads and writes use
  separate `Client` instances so bulk indexing can't head-of-line block
  queries.
- **Bulk write coalescing** (`indexer-worker.ts`): all ingest writes funnel
  through one worker, so batches stay coalesced and replaceable-slot
  resolution has a single writer.

## Code Style

### Prefer Node.js Builtins

Always use Node.js builtin modules for better portability and compatibility:

- **Use `node:` imports**: Import Node.js builtins using the `node:` protocol
- **Exception**: The WebSocket server in `src/server.ts` uses Bun's native `Bun.serve` 
  with WebSocket support for optimal performance
- **Examples**:
  - ✅ `import { readFile } from "node:fs/promises"` 
  - ✅ `import process from "node:process"`
  - ✅ `import { ServerWebSocket } from "bun"` (WebSocket server only)

This approach ensures most code remains portable while taking advantage of Bun's
excellent WebSocket performance.

## CPU Profiling

Bun supports built-in CPU profiling with markdown output (ideal for LLM analysis).

### Local profiling

```bash
bun --cpu-prof --cpu-prof-md --cpu-prof-dir=/tmp/bun-profiles --cpu-prof-interval=1000 src/server.ts
# Generate load, then stop with Ctrl+C (SIGINT)
# Profile is written to /tmp/bun-profiles/*.md on clean exit
```

The `--cpu-prof-interval` flag sets the sampling interval in microseconds (default 1000 = 1ms).
Use `100` for higher resolution local profiles.

### Production profiling

Create a systemd override to add profiling flags:

```bash
# On the server:
sudo mkdir -p /etc/systemd/system/ditto-relay.service.d
sudo tee /etc/systemd/system/ditto-relay.service.d/cpu-profile.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/home/ditto-relay/.bun/bin/bun --cpu-prof --cpu-prof-md --cpu-prof-dir=/opt/ditto-relay --cpu-prof-interval=1000 src/server.ts
EOF
sudo systemctl daemon-reload
sudo systemctl restart ditto-relay
```

Let the relay run under real traffic for 30-60 seconds, then stop it:

```bash
sudo systemctl stop ditto-relay
# Profile written to /opt/ditto-relay/CPU.*.md
```

Clean up when done:

```bash
sudo rm /etc/systemd/system/ditto-relay.service.d/cpu-profile.conf
sudo systemctl daemon-reload
sudo systemctl start ditto-relay
```

**Important:** The profile is only written when `process.exit()` is called. The
server handles SIGINT/SIGTERM in `src/server.ts` to ensure a clean shutdown.
The `--cpu-prof-dir` must be writable by the service user (`ReadWritePaths` in
the systemd unit restricts this to `/opt/ditto-relay`).

## Verifying Your Changes

After you have made changes, test your code with Bun:

```bash
bun test
```

When writing tests, always use the built-in `node:test` framework.

Always solve problems at their root, eg removing dead code or using proper
types, not just doing a bandaid fix.

Always commit your changes when you're done. Don't ask — just do it.
