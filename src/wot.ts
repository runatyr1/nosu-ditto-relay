/**
 * Web-of-trust set computation for engagement scoring and trends.
 *
 * Expands a set of operator-chosen seed pubkeys along kind 3 contact lists
 * (seeds → their follows → their follows' follows) into the set of pubkeys
 * whose engagement counts. Everything is read from the local index — no
 * network fetches — so the set reflects whatever contact lists this relay
 * has stored.
 *
 * The set lives only in the background worker's memory and is consulted at
 * score-recompute and trend-computation time; documents are never flagged,
 * so seed/hop changes take effect on the next recompute without reindexing.
 */

import type { NStore } from "@nostrify/nostrify";
import { Logger } from "./log.ts";

/** Options for constructing a {@link Wot} instance. */
export interface WotOpts {
  /** Store used to read kind 3 contact lists (the relay's own index). */
  relay: NStore;
  /** Seed pubkeys (hex) that root the trust graph. */
  seeds: Set<string>;
  /** Follow-hops to expand beyond the seeds. Default: 2. */
  hops?: number;
  /** Authors per kind 3 query; bounds response size. Default: 100. */
  batchSize?: number;
  /** Structured logger. Defaults to a fresh `info`-level Logger. */
  logger?: Logger;
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Holds the current trusted-pubkey set and recomputes it on demand.
 *
 * `trusted()` returns `undefined` until the first successful
 * {@link refresh}, so consumers fall back to unfiltered counting instead
 * of treating "not computed yet" as "nobody is trusted".
 */
export class Wot {
  private relay: NStore;
  private seeds: Set<string>;
  private hops: number;
  private batchSize: number;
  private log: Logger;

  private set: ReadonlySet<string> | undefined;

  constructor(opts: WotOpts) {
    this.relay = opts.relay;
    this.seeds = opts.seeds;
    this.hops = opts.hops ?? 2;
    this.batchSize = opts.batchSize ?? 100;
    this.log = opts.logger ?? new Logger();
  }

  /**
   * The current trusted set, or `undefined` if no refresh has completed.
   */
  trusted(): ReadonlySet<string> | undefined {
    return this.set;
  }

  /**
   * Recompute the trusted set from the seeds' contact lists.
   *
   * Builds the new set fully before swapping it in, so a slow or failing
   * refresh never leaves consumers with a partial set.
   */
  async refresh(): Promise<void> {
    const start = Date.now();
    const result = new Set(this.seeds);
    let frontier = [...this.seeds];

    for (let hop = 0; hop < this.hops && frontier.length > 0; hop++) {
      const follows = await this.fetchFollows(frontier);
      frontier = [];
      for (const pk of follows) {
        if (!result.has(pk)) {
          result.add(pk);
          frontier.push(pk);
        }
      }
    }

    this.set = result;
    this.log.info("wot_refreshed", {
      size: result.size,
      seeds: this.seeds.size,
      hops: this.hops,
      duration_ms: Date.now() - start,
    });
  }

  /**
   * Fetch the union of `p` tags from the authors' kind 3 contact lists.
   * Queried in batches to bound per-query response size — contact lists
   * routinely carry hundreds of tags each.
   */
  private async fetchFollows(authors: string[]): Promise<Set<string>> {
    const follows = new Set<string>();

    for (let i = 0; i < authors.length; i += this.batchSize) {
      const batch = authors.slice(i, i + this.batchSize);
      const events = await this.relay.query([
        { kinds: [3], authors: batch, limit: batch.length },
      ]);

      for (const event of events) {
        for (const tag of event.tags) {
          if (tag[0] !== "p" || typeof tag[1] !== "string") continue;
          const pk = tag[1].toLowerCase();
          if (HEX64_RE.test(pk)) follows.add(pk);
        }
      }
    }

    return follows;
  }
}
