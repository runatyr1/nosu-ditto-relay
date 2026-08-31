import type { NostrEvent } from "nostr-tools";

/**
 * NIP-40: whether an event's `expiration` tag has passed.
 *
 * Shared by the relay — which refuses to accept or broadcast an expired
 * event — and the storage layer, which drops expired events from query
 * results. The two have to agree on what "expired" means, and a relay
 * that broadcast an event it would then refuse to serve (or vice versa)
 * would be visibly inconsistent to a client watching both.
 *
 * A missing tag, a tag with no value, or a value that isn't a number all
 * mean "does not expire": NIP-40 defines expiry only for a well-formed
 * timestamp, and refusing to serve an event over a malformed tag would
 * hide it forever.
 *
 * `now` is injectable so callers filtering a batch can stamp the whole
 * batch with one clock reading.
 */
export function isExpired(
  event: NostrEvent,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const expirationTag = event.tags.find(
    (tag) => tag[0] === "expiration" && tag.length >= 2,
  );
  if (!expirationTag) return false;
  const expiration = Number.parseInt(expirationTag[1], 10);
  if (Number.isNaN(expiration)) return false;
  return expiration <= now;
}
