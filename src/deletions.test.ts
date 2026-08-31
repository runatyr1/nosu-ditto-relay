import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Filter, NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import {
  applyDeletionRequest,
  applyVanishRequest,
  authorizedATagFilters,
  canDelete,
  type DeletableStore,
  eTagTargets,
} from "./deletions.ts";

/** A store that records what it was asked to remove. */
function createMockStore(stored: NostrEvent[] = []) {
  const removals: Array<{ filters: Filter[]; excludeKinds?: number[] }> = [];
  const store: DeletableStore = {
    query: async (filters) => {
      const ids = new Set(filters.flatMap((f) => f.ids ?? []));
      return stored.filter((event) => ids.has(event.id));
    },
    remove: async (filters, opts) => {
      removals.push({ filters, excludeKinds: opts?.excludeKinds });
    },
  };
  return { store, removals };
}

const now = Math.floor(Date.now() / 1000);

describe("canDelete", () => {
  it("lets an author delete their own event", () => {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      { kind: 1, created_at: now, tags: [], content: "mine" },
      sk,
    );

    assert.equal(canDelete(getPublicKey(sk), event), true);
  });

  it("refuses to let anyone else delete it", () => {
    const author = generateSecretKey();
    const stranger = generateSecretKey();
    const event = finalizeEvent(
      { kind: 1, created_at: now, tags: [], content: "not yours" },
      author,
    );

    assert.equal(canDelete(getPublicKey(stranger), event), false);
  });

  it("lets the p-tagged recipient delete a gift wrap", () => {
    const signer = generateSecretKey();
    const recipient = getPublicKey(generateSecretKey());
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now,
        tags: [["p", recipient]],
        content: "sealed",
      },
      signer,
    );

    assert.equal(canDelete(recipient, wrap), true);
  });

  it("refuses to let a gift wrap's signer delete it", () => {
    // NIP-59: the signer may be a deterministic conversation key shared with
    // the counterparty, so signing is not ownership.
    const signer = generateSecretKey();
    const recipient = getPublicKey(generateSecretKey());
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now,
        tags: [["p", recipient]],
        content: "sealed",
      },
      signer,
    );

    assert.equal(canDelete(getPublicKey(signer), wrap), false);
  });
});

describe("authorizedATagFilters", () => {
  it("builds a bounded filter for a coordinate the requester authored", () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const request = finalizeEvent(
      {
        kind: 5,
        created_at: now,
        tags: [["a", `30023:${pubkey}:my-article`]],
        content: "",
      },
      sk,
    );

    assert.deepEqual(authorizedATagFilters(request), [
      {
        kinds: [30023],
        authors: [pubkey],
        until: now,
        "#d": ["my-article"],
      },
    ]);
  });

  it("drops coordinates belonging to someone else", () => {
    const sk = generateSecretKey();
    const victim = getPublicKey(generateSecretKey());
    const request = finalizeEvent(
      {
        kind: 5,
        created_at: now,
        tags: [["a", `30023:${victim}:their-article`]],
        content: "",
      },
      sk,
    );

    assert.deepEqual(authorizedATagFilters(request), []);
  });

  it("omits #d for a replaceable coordinate with an empty d-tag", () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const request = finalizeEvent(
      { kind: 5, created_at: now, tags: [["a", `0:${pubkey}:`]], content: "" },
      sk,
    );

    const filters = authorizedATagFilters(request);
    assert.equal(filters.length, 1);
    assert.equal(filters[0]["#d"], undefined);
  });

  it("ignores malformed coordinates", () => {
    const sk = generateSecretKey();
    const request = finalizeEvent(
      {
        kind: 5,
        created_at: now,
        tags: [["a", "nonsense"], ["a"], ["a", "x:y:z"]],
        content: "",
      },
      sk,
    );

    assert.deepEqual(authorizedATagFilters(request), []);
  });
});

describe("eTagTargets", () => {
  it("collects e-tag values and ignores other tags", () => {
    const sk = generateSecretKey();
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const request = finalizeEvent(
      {
        kind: 5,
        created_at: now,
        tags: [["e", a], ["p", "c".repeat(64)], ["e", b], ["e"]],
        content: "",
      },
      sk,
    );

    assert.deepEqual(eTagTargets(request), [a, b]);
  });
});

describe("applyDeletionRequest", () => {
  it("removes only the events the requester authored", async () => {
    const sk = generateSecretKey();
    const other = generateSecretKey();

    const mine = finalizeEvent(
      { kind: 1, created_at: now - 10, tags: [], content: "mine" },
      sk,
    );
    const theirs = finalizeEvent(
      { kind: 1, created_at: now - 10, tags: [], content: "theirs" },
      other,
    );

    const { store, removals } = createMockStore([mine, theirs]);
    const request = finalizeEvent(
      {
        kind: 5,
        created_at: now,
        tags: [
          ["e", mine.id],
          ["e", theirs.id],
        ],
        content: "",
      },
      sk,
    );

    await applyDeletionRequest(store, request);

    assert.equal(removals.length, 1);
    assert.deepEqual(removals[0].filters, [{ ids: [mine.id] }]);
  });

  it("does not call remove when nothing is authorized", async () => {
    const sk = generateSecretKey();
    const other = generateSecretKey();
    const theirs = finalizeEvent(
      { kind: 1, created_at: now - 10, tags: [], content: "theirs" },
      other,
    );

    const { store, removals } = createMockStore([theirs]);
    const request = finalizeEvent(
      { kind: 5, created_at: now, tags: [["e", theirs.id]], content: "" },
      sk,
    );

    await applyDeletionRequest(store, request);

    assert.equal(removals.length, 0);
  });

  it("combines e-tag and a-tag deletions into one remove call", async () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const mine = finalizeEvent(
      { kind: 1, created_at: now - 10, tags: [], content: "mine" },
      sk,
    );

    const { store, removals } = createMockStore([mine]);
    const request = finalizeEvent(
      {
        kind: 5,
        created_at: now,
        tags: [
          ["e", mine.id],
          ["a", `30023:${pubkey}:article`],
        ],
        content: "",
      },
      sk,
    );

    await applyDeletionRequest(store, request);

    assert.equal(removals.length, 1);
    assert.equal(removals[0].filters.length, 2);
    assert.deepEqual(removals[0].filters[0], { ids: [mine.id] });
    assert.equal(removals[0].filters[1].kinds?.[0], 30023);
  });
});

describe("applyVanishRequest", () => {
  it("spares gift wraps it signed and sweeps those addressed to it", async () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const { store, removals } = createMockStore();

    const request = finalizeEvent(
      {
        kind: 62,
        created_at: now,
        tags: [["relay", "ALL_RELAYS"]],
        content: "",
      },
      sk,
    );

    await applyVanishRequest(store, request);

    assert.equal(removals.length, 2);

    // Everything it authored, except the gift wraps it signed.
    assert.deepEqual(removals[0].filters, [{ authors: [pubkey], until: now }]);
    assert.deepEqual(removals[0].excludeKinds, [1059]);

    // Gift wraps addressed to it.
    assert.deepEqual(removals[1].filters, [
      { kinds: [1059], "#p": [pubkey], until: now },
    ]);
  });
});
