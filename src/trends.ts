import type {
  NostrEvent,
  NostrFilter,
  NostrSigner,
  NStore,
} from "@nostrify/nostrify";
import type { TrustProvider } from "./opensearch.ts";
import type { Client } from "./opensearch-client.ts";

/** A single trending tag value with engagement metrics. */
export interface TrendingTagValue {
  /** The tag value (lowercased). */
  value: string;
  /** Number of distinct authors who used this tag value. */
  authors: number;
  /** Total number of uses across all events. */
  uses: number;
}

/** Options for constructing a {@link Trends} instance. */
export interface TrendsOpts {
  /** OpenSearch client. */
  client: Client;
  /** OpenSearch index name. */
  indexName: string;
  /** Relay instance used to publish trending label events. */
  relay: NStore;
  /** Optional callback to broadcast events to connected WebSocket subscribers. */
  broadcast?: (event: NostrEvent) => void;
  /**
   * Optional web-of-trust provider. When it returns a set, only trusted
   * authors count toward `authors`/`uses` and untrusted-only values are
   * dropped from the trend list entirely.
   */
  trustProvider?: TrustProvider;
}

/**
 * Computes trending tag values from OpenSearch and publishes them as
 * kind 1985 label events (matching Ditto's `pub.ditto.trends` label
 * namespace).
 */
export class Trends {
  private client: Client;
  private indexName: string;
  private relay: NStore;
  private broadcast?: (event: NostrEvent) => void;
  private trustProvider?: TrustProvider;

  constructor(opts: TrendsOpts) {
    this.client = opts.client;
    this.indexName = opts.indexName;
    this.relay = opts.relay;
    this.broadcast = opts.broadcast;
    this.trustProvider = opts.trustProvider;
  }

  /**
   * Get trending tag values for given tag names in the specified time frame.
   *
   * Uses OpenSearch `terms` + `cardinality` aggregations on the `tags_map`
   * field to replicate the Postgres-based trending query from Ditto:
   *
   * - Groups by lowercased tag value
   * - Counts distinct authors (`cardinality` on `pubkey`)
   * - Counts total uses (`doc_count`)
   * - Sorts by authors desc, then uses desc
   */
  async getTrendingTagValues(
    /** Tag names to aggregate on, e.g. `["t"]` or `["e", "q"]`. */
    tagNames: string[],
    /** Nostr filter for eligible events (kinds, authors, since, until, limit). */
    filter: NostrFilter,
    /** If present, only these tag values are permitted to trend. */
    values?: string[],
    /** If present, restrict to events with this language (OpenSearch `language` field). */
    language?: string,
  ): Promise<TrendingTagValue[]> {
    const limit = filter.limit ?? 20;

    // Build the bool/must query clauses
    const must: Record<string, unknown>[] = [{ term: { deleted: false } }];

    if (filter.kinds && filter.kinds.length > 0) {
      must.push({ terms: { kind: filter.kinds } });
    }
    if (filter.authors && filter.authors.length > 0) {
      must.push({ terms: { pubkey: filter.authors } });
    }
    if (typeof filter.since === "number" || typeof filter.until === "number") {
      const range: Record<string, number> = {};
      if (typeof filter.since === "number") range.gte = filter.since;
      if (typeof filter.until === "number") range.lte = filter.until;
      must.push({ range: { created_at: range } });
    }
    if (language) {
      must.push({ term: { language } });
    }

    // In trusted (WoT) mode, restrict the whole query to trusted authors so
    // the aggregation never sees a sybil swarm in the first place. Doing it
    // here rather than over the results is what keeps this bounded: the
    // previous approach asked each value bucket for its top 1000 authors and
    // filtered them in JS, which created `bucketSize * authors-per-value`
    // buckets — ~142 000 for trending pubkeys against a 65 535 ceiling,
    // because kind 3 contact lists carry hundreds of `p` tags each. It also
    // silently dropped every author past the 1000th and needed a bucket
    // over-fetch to compensate for ordering by untrusted doc counts. Both
    // problems disappear once the engine only counts trusted docs.
    //
    // This is one `terms` clause holding the entire WoT set, which is why
    // the index raises `max_terms_count` (see MAX_TERMS_COUNT).
    const trusted = this.trustProvider?.();
    if (trusted) {
      must.push({ terms: { pubkey: [...trusted] } });
    }

    // We need to run one aggregation per tag name (e.g. "e" and "q"), then
    // merge the buckets client-side.  Each tag name maps to a different
    // `tags_map.<name>` keyword field in OpenSearch.
    const bucketSize = limit * tagNames.length;
    const aggs: Record<string, unknown> = {};

    for (const tagName of tagNames) {
      const field = `tags_map.${tagName}`;

      // Optionally restrict to a set of allowed values
      const tagMust = [...must];
      if (values && values.length > 0) {
        tagMust.push({ terms: { [field]: values } });
      }

      aggs[`tag_${tagName}`] = {
        filter: { bool: { must: tagMust } },
        aggs: {
          values: {
            terms: {
              field,
              size: bucketSize,
            },
            aggs: {
              unique_authors: {
                cardinality: { field: "pubkey" },
              },
            },
          },
        },
      };
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        size: 0,
        query: { bool: { must } },
        aggs,
      } as Record<string, unknown>,
    });

    // Merge buckets across tag names.  The same value might appear under
    // both "e" and "q"; we sum uses and take the max authors (a rough
    // approximation — the exact distinct-author count across multiple tag
    // names would require a composite aggregation which is more complex).
    const merged = new Map<string, { authors: number; uses: number }>();

    for (const tagName of tagNames) {
      const aggResult = response.body.aggregations?.[`tag_${tagName}`] as
        | {
            values?: {
              buckets?: Array<{
                key: string;
                doc_count: number;
                unique_authors?: { value: number };
              }>;
            };
          }
        | undefined;

      const buckets = aggResult?.values?.buckets ?? [];

      for (const bucket of buckets) {
        const key = bucket.key.toLowerCase();
        // Marker tags with no value are indexed as '' — never trend those.
        if (!key) continue;

        // In trusted mode the query already excluded untrusted authors, so
        // these are trusted counts and a value used only by untrusted
        // pubkeys has no bucket here at all.
        const authors = bucket.unique_authors?.value ?? 0;
        const uses = bucket.doc_count;

        const existing = merged.get(key);

        if (existing) {
          existing.authors = Math.max(existing.authors, authors);
          existing.uses += uses;
        } else {
          merged.set(key, { authors, uses });
        }
      }
    }

    // Sort by authors desc, then uses desc (matching the Ditto query)
    const sorted = [...merged.entries()]
      .sort(([, a], [, b]) => b.authors - a.authors || b.uses - a.uses)
      .slice(0, limit);

    return sorted.map(([value, { authors, uses }]) => ({
      value,
      authors,
      uses,
    }));
  }

  /**
   * Compute trending tag values and publish a kind 1985 label event.
   *
   * Mirrors Ditto's `updateTrendingTags`: queries the last 24 hours,
   * builds a label event in the `pub.ditto.trends` namespace, signs it
   * with the provided signer, and stores it via the relay.
   */
  async updateTrendingTags(
    signer: NostrSigner,
    /** Label value for the `l` tag, e.g. `"#t"` or `"#p"`. */
    l: string,
    /** Primary tag name used in the label event tags, e.g. `"t"` or `"e"`. */
    tagName: string,
    /** Kinds of events to consider. */
    kinds: number[],
    /** Maximum number of trending values to include. */
    limit: number,
    /** Extra value appended to each tag tuple (e.g. relay URL). */
    extra = "",
    /** Additional tag names that alias the primary (e.g. `["q"]` for `"e"`). */
    aliases?: string[],
    /** If present, only these tag values are permitted to trend. */
    values?: string[],
    /** If present, restrict to events with this language. */
    language?: string,
  ): Promise<void> {
    const signal = AbortSignal.timeout(1000);

    const yesterday = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const now = Math.floor(Date.now() / 1000);

    const tagNames = aliases ? [tagName, ...aliases] : [tagName];

    const trends = await this.getTrendingTagValues(
      tagNames,
      { kinds, since: yesterday, until: now, limit },
      values,
      language,
    );

    if (trends.length === 0) {
      return;
    }

    const label = await signer.signEvent({
      kind: 1985,
      content: "",
      tags: [
        ["L", "pub.ditto.trends"],
        ["l", l, "pub.ditto.trends"],
        ...trends.map(({ value, authors, uses }) => [
          tagName,
          value,
          extra,
          authors.toString(),
          uses.toString(),
        ]),
      ],
      created_at: Math.floor(Date.now() / 1000),
    });

    await this.relay.event(label, { signal });
    this.broadcast?.(label);
  }

  /** Update trending pubkeys. */
  updateTrendingPubkeys(signer: NostrSigner, relayUrl: string): Promise<void> {
    return this.updateTrendingTags(
      signer,
      "#p",
      "p",
      [1, 3, 6, 7, 9735],
      40,
      relayUrl,
    );
  }

  /** Update trending zapped events. */
  updateTrendingZappedEvents(
    signer: NostrSigner,
    relayUrl: string,
  ): Promise<void> {
    return this.updateTrendingTags(
      signer,
      "zapped",
      "e",
      [9735],
      40,
      relayUrl,
      ["q"],
    );
  }

  /** Update trending events (all languages). */
  updateTrendingEvents(signer: NostrSigner, relayUrl: string): Promise<void> {
    return this.updateTrendingTags(
      signer,
      "#e",
      "e",
      [1, 6, 7, 9735],
      40,
      relayUrl,
      ["q"],
    );
  }

  /**
   * Update per-language trending events.
   *
   * For each language in the list, produces a kind 1985 event with label
   * `#e.<language>` (e.g. `#e.pt`, `#e.en`) containing trending events
   * filtered to that language.
   */
  async updateTrendingEventsByLanguage(
    signer: NostrSigner,
    relayUrl: string,
    languages: string[],
  ): Promise<void> {
    await Promise.allSettled(
      languages.map((lang) =>
        this.updateTrendingTags(
          signer,
          `#e.${lang}`,
          "e",
          [1, 6, 7, 9735],
          40,
          relayUrl,
          ["q"],
          undefined,
          lang,
        ),
      ),
    );
  }

  /** Update trending hashtags. */
  updateTrendingHashtags(signer: NostrSigner): Promise<void> {
    return this.updateTrendingTags(signer, "#t", "t", [1], 20);
  }

  /** Update trending links. */
  updateTrendingLinks(signer: NostrSigner): Promise<void> {
    return this.updateTrendingTags(signer, "#r", "r", [1], 20);
  }
}
