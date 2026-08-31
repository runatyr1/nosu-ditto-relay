/**
 * Deletion semantics for NIP-09 deletion requests (kind 5) and NIP-62
 * vanish requests (kind 62).
 *
 * These live outside `relay.ts` because two callers need identical rules:
 * the live ingest path, and the bulk importer in `scripts/import.ts`. The
 * authorization checks here are the only thing standing between a deletion
 * request and someone else's events, so a second, drifting copy of them in
 * the importer would be a privacy bug waiting to happen.
 *
 * The rules ({@link canDelete}, {@link authorizedATagFilters}) are separated
 * from the execution ({@link applyDeletionRequest}) because the two callers
 * execute differently. The relay applies one request at a time against a
 * live index. The importer replays millions of historical requests and has
 * to batch them — it resolves e-tag targets for hundreds of requests in one
 * query and marks them in one bulk update — so it reuses the rules but not
 * the per-request round trips.
 *
 * Storage is mutated only through `remove`, which the OpenSearch backend
 * implements as a soft delete (`deleted: true`). A store without `remove`
 * is a no-op.
 */

import type { Filter, NostrEvent } from "nostr-tools";

/**
 * The storage surface a deletion needs: id lookups to authorize `e` tags,
 * and a filtered remove to carry the deletion out.
 *
 * Declared structurally rather than importing `AnalyzableRelay` from
 * `relay.ts`, which imports this module. Both `AnalyzableRelay` and
 * `OpenSearchRelay` satisfy it.
 */
export interface DeletableStore {
  query(
    filters: Filter[],
    opts?: { signal?: AbortSignal; includeAuthKinds?: boolean },
  ): Promise<NostrEvent[]>;
  /**
   * Remove events matching the filters. Events whose kind is listed in
   * `excludeKinds` are spared even when they match.
   */
  remove?(
    filters: Filter[],
    opts?: { signal?: AbortSignal; excludeKinds?: number[] },
  ): Promise<void>;
}

/**
 * Whether `deleterPubkey` is allowed to delete `target`.
 *
 * NIP-59: a gift wrap (kind 1059) may only be deleted by the p-tagged
 * recipient — never by its author/signer, which may be a deterministic
 * conversation key shared with the counterparty (see
 * nostr-protocol/nips#2396), nor by the shared key.
 *
 * NIP-09: every other kind may only be deleted by its author.
 */
export function canDelete(deleterPubkey: string, target: NostrEvent): boolean {
  if (target.kind === 1059) {
    return target.tags.some(
      (tag) => tag[0] === "p" && tag[1] === deleterPubkey,
    );
  }
  return target.pubkey === deleterPubkey;
}

/**
 * The filters a deletion request's `a` tags authorize.
 *
 * Coordinates the requester did not author are dropped (NIP-09). Each
 * filter is bounded by the request's own `created_at`, so a deletion can't
 * reach a replacement published after it.
 */
export function authorizedATagFilters(event: NostrEvent): Filter[] {
  const filters: Filter[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== "a" || tag.length < 2) continue;

    const parts = tag[1].split(":");
    if (parts.length !== 3) continue;

    const [kindStr, pubkey, dTag] = parts;
    const kind = Number.parseInt(kindStr, 10);

    // NIP-09: Only allow deletion of own events (pubkey must match)
    if (Number.isNaN(kind) || pubkey !== event.pubkey) continue;

    const filter: Filter = {
      kinds: [kind],
      authors: [pubkey],
      // NIP-09: delete all versions up to the deletion request timestamp.
      until: event.created_at,
    };
    // Only add d-tag filter for addressable events (with non-empty d-tag)
    if (dTag) {
      filter["#d"] = [dTag];
    }
    filters.push(filter);
  }

  return filters;
}

/** The event ids a deletion request's `e` tags name, before authorization. */
export function eTagTargets(event: NostrEvent): string[] {
  return event.tags
    .filter((tag) => tag[0] === "e" && tag.length >= 2)
    .map((tag) => tag[1]);
}

/**
 * Apply a NIP-09 deletion request against storage.
 *
 * Resolves the request's `e` and `a` tags into filters and removes only
 * what the requester is allowed to remove, per {@link canDelete} and
 * {@link authorizedATagFilters}.
 *
 * Throws whatever storage throws; callers decide how to report it.
 */
export async function applyDeletionRequest(
  storage: DeletableStore,
  event: NostrEvent,
): Promise<void> {
  const filters: Filter[] = [];

  // Resolve e-tagged events and authorize each deletion in code. A
  // single id-keyed query covers both cases: the deleter's own events
  // (regular NIP-09 deletion) and gift wraps addressed to the deleter.
  const eTagValues = eTagTargets(event);
  if (eTagValues.length > 0) {
    // Internal lookup: every e-tagged event must be considered, so the
    // limit is the id count rather than the client-facing default.
    const matched = await storage.query([
      { ids: eTagValues, limit: eTagValues.length },
    ]);
    const deletableIds = matched
      .filter((target) => canDelete(event.pubkey, target))
      .map((target) => target.id);

    if (deletableIds.length > 0) {
      filters.push({ ids: deletableIds });
    }
  }

  filters.push(...authorizedATagFilters(event));

  if (filters.length > 0 && storage.remove) {
    await storage.remove(filters);
  }
}

/**
 * Apply a NIP-62 vanish request against storage.
 *
 * Deletes everything the requester authored up to the request's
 * `created_at`, except the gift wraps it signed — NIP-59 says a gift wrap
 * belongs to its p-tagged recipient, so its signer can't make the
 * recipient's copy vanish. Gift wraps addressed *to* the requester are
 * swept separately, which NIP-62 asks relays to do.
 *
 * The caller is responsible for deciding that this relay is targeted by the
 * request's `relay` tags; this function only carries out the deletion.
 */
export async function applyVanishRequest(
  storage: DeletableStore,
  event: NostrEvent,
): Promise<void> {
  if (!storage.remove) return;

  await storage.remove(
    [
      {
        authors: [event.pubkey],
        until: event.created_at,
      },
    ],
    { excludeKinds: [1059] },
  );

  // NIP-62: Relays SHOULD delete all NIP-59 Gift Wraps (kind 1059)
  // that p-tagged the pubkey.
  await storage.remove([
    {
      kinds: [1059],
      "#p": [event.pubkey],
      until: event.created_at,
    },
  ]);
}
