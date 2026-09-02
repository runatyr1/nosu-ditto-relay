/**
 * NSFW classification for the NIP-50 `nsfw:` search extension.
 *
 * An event is classified NSFW when it carries a media attachment AND at
 * least one `t` tag (case-insensitive) from the NSFW hashtag set. Both
 * signals are required: a note that merely *mentions* #nsfw in a hashtag
 * isn't adult content — the attachment is what the tag is warning about.
 *
 * NIP-36 `content-warning` is deliberately NOT a signal here: it covers
 * spoilers, politics, food, and other non-adult sensitivities, and clients
 * that want to exclude it can already use `-tag:content-warning`.
 */

import type { NostrEvent } from "nostr-tools";

/**
 * Default NSFW hashtag set (lowercase). Overridable via the
 * `NSFW_HASHTAGS` env var (see `Config.nsfwHashtags`).
 *
 * Scoped to hashtags in broad, general use as adult-content markers. Two
 * kinds of tag are deliberately left out:
 *
 *   - Tags with common non-adult usage: `girls`, `teen`, `teens` (family
 *     photos, youth events), `fuck` (ordinary profanity), `femboy`/`femboi`
 *     (identity and aesthetic tags), `dick` (a common name), and `ass`,
 *     `butt`, `sexy` (routine casual usage).
 *   - Long-tail compounds and campaign-specific spam tags (`porntube`,
 *     `freeporn`, `dickpic`, …). They add index-time work and maintenance
 *     for events the general tags above already catch, and operators who
 *     want them can extend the set via `NSFW_HASHTAGS`.
 *
 * The bar for inclusion is lower than for a *blocking* policy: an entry here
 * only marks an event, and only when it also carries a media attachment.
 */
export const DEFAULT_NSFW_HASHTAGS: ReadonlySet<string> = new Set([
  // General adult-content markers.
  "nsfw",
  "adult",
  "nude",
  "nudes",
  "nudity",
  "sex",
  "xxx",
  "onlyfans",
  "porn",
  "porno",
  // Anatomy and acts that are overwhelmingly adult as hashtags.
  "boobs",
  "tits",
  "pussy",
  "cock",
  "milf",
  "slut",
  "fetish",
  // Anime/manga adult tags.
  "hentai",
  "loli",
]);

/**
 * Classify an event as NSFW.
 *
 * @param event The event to classify.
 * @param media Whether the event has a media attachment (from `detectMedia`).
 * @param nsfwHashtags Lowercase hashtag set; an empty set disables
 *   classification entirely.
 */
export function detectNsfw(
  event: NostrEvent,
  media: boolean | undefined,
  nsfwHashtags: ReadonlySet<string>,
): boolean {
  if (!media || nsfwHashtags.size === 0) return false;
  return event.tags.some(
    (tag) =>
      tag[0] === "t" &&
      tag.length >= 2 &&
      nsfwHashtags.has(tag[1].toLowerCase()),
  );
}
