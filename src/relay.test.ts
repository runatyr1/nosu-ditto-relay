import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Filter, NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { StorageOverloaded } from "./errors.ts";
import {
  bytesToHex,
  hexToBytes,
  Negentropy,
  NegentropyStorageVector,
} from "./negentropy.ts";
import {
  type AnalyzableRelay,
  clampLimit,
  clampUntil,
  Relay,
  type RelayConn,
} from "./relay.ts";

describe("Relay", () => {
  let relay: Relay;
  let mockStorage: AnalyzableRelay;
  let mockWs: RelayConn;
  let sentMessages: unknown[][];
  let consoleErrorSpy: typeof console.error;
  let consoleLogSpy: typeof console.log;

  beforeEach(() => {
    sentMessages = [];

    // Suppress console output during tests
    consoleErrorSpy = console.error;
    consoleLogSpy = console.log;
    console.error = () => {};
    console.log = () => {};

    // Create mock storage with NRelay interface
    mockStorage = {
      event: async (_event: NostrEvent) => {},
      query: async (_filters: Filter[]) => [],
      remove: async (_filters: Filter[]) => {},
    } as unknown as AnalyzableRelay;

    // Create mock WebSocket
    mockWs = {
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
      data: {
        subscriptions: new Set(),
        challenge: "",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as RelayConn;

    relay = new Relay(mockStorage, { relayUrl: "wss://relay.test/" });
  });

  afterEach(() => {
    // Restore console output
    console.error = consoleErrorSpy;
    console.log = consoleLogSpy;
  });

  describe("constructor", () => {
    it("should create relay with default relay info", () => {
      const info = relay.getRelayInfo();
      assert.equal(info.name, "Ditto Relay");
      assert.equal(info.software, "https://gitlab.com/soapbox-pub/ditto-relay");
      assert.equal(info.version, "0.1.0");
      assert.deepEqual(
        info.supported_nips,
        [1, 9, 11, 13, 40, 42, 45, 50, 62, 70, 77],
      );
    });

    it("should allow customizing relay info", () => {
      const customRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        relayInfo: {
          name: "Custom Relay",
          description: "My custom relay",
          pubkey: "abc123",
        },
      });

      const info = customRelay.getRelayInfo();
      assert.equal(info.name, "Custom Relay");
      assert.equal(info.description, "My custom relay");
      assert.equal(info.pubkey, "abc123");
      assert.equal(info.software, "https://gitlab.com/soapbox-pub/ditto-relay"); // defaults still work
    });
  });

  describe("handleEvent", () => {
    it("should accept valid event and send OK response", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Test event",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should successfully store event", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Test event",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should handle deletion events (kind 5)", async () => {
      const sk = generateSecretKey();
      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["e", "event123"]],
          content: "",
        },
        sk,
      );

      await relay.handleEvent(mockWs, deletionEvent);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);
    });

    it("should only allow deletion of own events via a-tag (NIP-09)", async () => {
      const sk = generateSecretKey();
      const otherPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        generateSecretKey(),
      ).pubkey;

      let removeCalled = false;
      let removeFilters: Filter[] = [];

      mockStorage.remove = async (filters: Filter[]) => {
        removeCalled = true;
        removeFilters = filters;
      };

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["a", `30023:${otherPubkey}:my-article`], // Trying to delete someone else's event
          ],
          content: "",
        },
        sk,
      );

      await relay.handleEvent(mockWs, deletionEvent);
      relay.flushBroadcasts();

      // Event should be accepted (deletion events are always stored)
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);

      // But remove should not be called with the mismatched pubkey
      if (removeCalled) {
        // If remove was called, verify it has no filters (a-tag was rejected)
        assert.equal(removeFilters.length, 0);
      }
    });

    it("should allow deletion of own events via a-tag (NIP-09)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      let removeCalled = false;
      let removeFilters: Filter[] = [];

      mockStorage.remove = async (filters: Filter[]) => {
        removeCalled = true;
        removeFilters = filters;
      };

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["a", `30023:${myPubkey}:my-article`], // Deleting own event
          ],
          content: "",
        },
        sk,
      );

      await relay.handleEvent(mockWs, deletionEvent);
      relay.flushBroadcasts();

      // Event should be accepted
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);

      // Remove should be called with the correct filter
      assert.ok(removeCalled);
      assert.equal(removeFilters.length, 1);
      assert.deepEqual(removeFilters[0].kinds, [30023]);
      assert.deepEqual(removeFilters[0].authors, [myPubkey]);
      assert.deepEqual(removeFilters[0]["#d"], ["my-article"]);
    });

    it("should allow p-tagged recipient to delete gift wraps via e-tag (NIP-59)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      // The gift wrap is p-tagged to the deleter, so it may be deleted.
      const giftWrap: NostrEvent = {
        id: "giftwrap123",
        pubkey: "deadbeef".repeat(8),
        kind: 1059,
        created_at: 0,
        tags: [["p", myPubkey]],
        content: "",
        sig: "",
      };

      let queryFilters: Filter[] = [];
      mockStorage.query = async (filters: Filter[]) => {
        queryFilters = filters;
        return [giftWrap];
      };

      let removeFilters: Filter[] = [];
      mockStorage.remove = async (filters: Filter[]) => {
        removeFilters = filters;
      };

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["e", "giftwrap123"]],
          content: "",
        },
        sk,
      );

      await relay.handleEvent(mockWs, deletionEvent);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);

      // The deletion resolves the e-tagged ids with a single id-keyed query,
      // limited to the id count so no e-tag is silently dropped.
      assert.equal(queryFilters.length, 1);
      assert.deepEqual(queryFilters[0], { ids: ["giftwrap123"], limit: 1 });

      // The gift wrap is p-tagged to the deleter, so it is removed by id.
      assert.equal(removeFilters.length, 1);
      assert.deepEqual(removeFilters[0], { ids: ["giftwrap123"] });
    });

    it("should not let a gift wrap author delete it via e-tag (NIP-59)", async () => {
      // Regression for nostr-protocol/nips#2396: with conversation-key-signed
      // gift wraps the author/signer is deterministic, but only the p-tagged
      // recipient may delete a kind 1059 wrap — never its author.
      const sk = generateSecretKey();
      const authorPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;
      const recipientPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        generateSecretKey(),
      ).pubkey;

      // The gift wrap is authored by the deleter but p-tagged to someone else.
      const giftWrap: NostrEvent = {
        id: "giftwrap123",
        pubkey: authorPubkey,
        kind: 1059,
        created_at: 0,
        tags: [["p", recipientPubkey]],
        content: "",
        sig: "",
      };

      mockStorage.query = async () => [giftWrap];

      let removeCalled = false;
      let removeFilters: Filter[] = [];
      mockStorage.remove = async (filters: Filter[]) => {
        removeCalled = true;
        removeFilters = filters;
      };

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["e", "giftwrap123"]],
          content: "",
        },
        sk,
      );

      await relay.handleEvent(mockWs, deletionEvent);
      relay.flushBroadcasts();

      // Deletion event is still accepted and stored.
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);

      // But the gift wrap must NOT be removed: the author is not the recipient.
      if (removeCalled) {
        assert.equal(removeFilters.length, 0);
      }
    });

    it("should handle vanish request targeting this relay (kind 62, NIP-62)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const removeCalls: Array<{
        filters: Filter[];
        opts?: { excludeKinds?: number[] };
      }> = [];
      mockStorage.remove = async (
        filters: Filter[],
        opts?: { excludeKinds?: number[] },
      ) => {
        removeCalls.push({ filters, opts });
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "wss://relay.test/"]],
          content: "Requesting removal of all my data.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);
      relay.flushBroadcasts();

      // Event should be accepted and stored for bookkeeping
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Remove should be called twice: once for all events, once for gift wraps
      assert.equal(removeCalls.length, 2);

      // First call: delete all events from this pubkey, sparing gift wraps it
      // signed (those belong to their p-tagged recipients).
      assert.deepEqual(removeCalls[0].filters, [
        { authors: [myPubkey], until: vanishEvent.created_at },
      ]);
      assert.deepEqual(removeCalls[0].opts?.excludeKinds, [1059]);

      // Second call: delete gift wraps (kind 1059) p-tagging this pubkey
      assert.deepEqual(removeCalls[1].filters, [
        { kinds: [1059], "#p": [myPubkey], until: vanishEvent.created_at },
      ]);
      assert.equal(removeCalls[1].opts?.excludeKinds, undefined);
    });

    it("should handle vanish request with ALL_RELAYS tag (NIP-62)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const removeCalls: Filter[][] = [];
      mockStorage.remove = async (filters: Filter[]) => {
        removeCalls.push(filters);
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "ALL_RELAYS"]],
          content: "Requesting complete deletion from all relays.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Should process vanish for ALL_RELAYS
      assert.equal(removeCalls.length, 2);
      assert.deepEqual(removeCalls[0], [
        { authors: [myPubkey], until: vanishEvent.created_at },
      ]);
      assert.deepEqual(removeCalls[1], [
        { kinds: [1059], "#p": [myPubkey], until: vanishEvent.created_at },
      ]);
    });

    it("should ignore vanish request targeting a different relay (NIP-62)", async () => {
      const sk = generateSecretKey();

      let removeCalled = false;
      mockStorage.remove = async (_filters: Filter[]) => {
        removeCalled = true;
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "wss://other-relay.example.com/"]],
          content: "Requesting removal from a different relay.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);
      relay.flushBroadcasts();

      // Event should be accepted (stored for bookkeeping)
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Remove should NOT be called since this relay is not targeted
      assert.ok(!removeCalled);
    });

    it("should reject vanish request with no relay tags (NIP-62)", async () => {
      const sk = generateSecretKey();

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Invalid vanish request.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);
      relay.flushBroadcasts();

      // Event should be rejected
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        vanishEvent.id,
        false,
        "invalid: kind 62 event must include at least one relay tag",
      ]);
    });

    it("should handle vanish request with relay URL without trailing slash (NIP-62)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const removeCalls: Filter[][] = [];
      mockStorage.remove = async (filters: Filter[]) => {
        removeCalls.push(filters);
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "wss://relay.test"]], // No trailing slash
          content: "Requesting removal.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Should still match due to trailing slash tolerance
      assert.equal(removeCalls.length, 2);
      assert.deepEqual(removeCalls[0], [
        { authors: [myPubkey], until: vanishEvent.created_at },
      ]);
    });

    it("should handle storage errors gracefully", async () => {
      mockStorage.event = async () => {
        throw new Error("Storage error");
      };

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Error event",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "error: Storage error",
      ]);
    });

    it("should not store ephemeral events (kinds 20000-29999)", async () => {
      let storageEventCalled = false;
      mockStorage.event = async () => {
        storageEventCalled = true;
      };

      const sk = generateSecretKey();
      const ephemeralEvent = finalizeEvent(
        {
          kind: 20000, // ephemeral event
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Ephemeral event",
        },
        sk,
      );

      await relay.handleEvent(mockWs, ephemeralEvent);
      relay.flushBroadcasts();

      // Should accept the event
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", ephemeralEvent.id, true, ""]);

      // But should NOT call storage.event
      assert.equal(storageEventCalled, false);
    });

    it("should broadcast ephemeral events to active subscribers", async () => {
      let storageEventCalled = false;
      mockStorage.event = async () => {
        storageEventCalled = true;
      };

      // Create a subscriber
      const sub = {
        send: (message: string) => {
          sentMessages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Set(),
          challenge: "",
          authedPubkeys: new Set(),
        },
      } as unknown as RelayConn;

      relay.handleOpen(sub);
      mockStorage.query = async () => [];
      await relay.handleReq(sub, "sub1", [{ kinds: [20000] }]);
      sentMessages.length = 0;

      // Publish ephemeral event
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const ephemeralEvent = finalizeEvent(
        {
          kind: 20000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Ephemeral broadcast",
        },
        sk,
      );

      await relay.handleEvent(mockWs, ephemeralEvent);
      relay.flushBroadcasts();

      // Should be accepted and broadcast
      const okMsg = sentMessages.find((m) => m[0] === "OK");
      const eventMsg = sentMessages.find((m) => m[0] === "EVENT");
      assert.ok(okMsg);
      assert.ok(eventMsg);
      assert.equal(eventMsg[1], "sub1");
      assert.equal((eventMsg[2] as NostrEvent).id, ephemeralEvent.id);

      // But NOT stored
      assert.equal(storageEventCalled, false);
    });

    it("should NACK with 'relay overloaded' when storage.event throws StorageOverloaded", async () => {
      const overloadedStorage = {
        ...mockStorage,
        event: async () => {
          throw new StorageOverloaded(5000, 5000);
        },
      } as unknown as AnalyzableRelay;

      const overloadedRelay = new Relay(overloadedStorage, {
        relayUrl: "wss://relay.test/",
        analyze: () => ({ verified: true }),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "overloaded storage",
        },
        sk,
      );

      await overloadedRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "error: relay overloaded, try again",
      ]);
    });
  });

  describe("banned hashtags", () => {
    it("should reject an event containing a banned hashtag", async () => {
      let storageEventCalled = false;
      const storage = {
        ...mockStorage,
        event: async () => {
          storageEventCalled = true;
        },
      } as unknown as AnalyzableRelay;
      const bannedRelay = new Relay(storage, {
        relayUrl: "wss://relay.test/",
        bannedHashtags: new Set(["spam"]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "spam"]],
          content: "buy now",
        },
        sk,
      );

      await bannedRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "blocked: event contains a banned hashtag",
      ]);
      assert.equal(storageEventCalled, false);
    });

    it("should match banned hashtags case-insensitively", async () => {
      const bannedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        bannedHashtags: new Set(["spam"]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "SPAM"]],
          content: "buy now",
        },
        sk,
      );

      await bannedRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages[0][2], false);
      assert.equal(
        sentMessages[0][3],
        "blocked: event contains a banned hashtag",
      );
    });

    it("should accept an event with a non-banned hashtag", async () => {
      const bannedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        bannedHashtags: new Set(["spam"]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "nostr"]],
          content: "hello",
        },
        sk,
      );

      await bannedRelay.handleEvent(mockWs, event);
      bannedRelay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should accept any event when no hashtags are banned", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "spam"]],
          content: "hello",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });
  });

  describe("rejectNsfw", () => {
    /** Build an event whose analysis reports the given `nsfw` classification. */
    const nsfwAnalyze = (nsfw: boolean) => () => ({ verified: true, nsfw });

    it("should reject an event the analyzer classified as NSFW", async () => {
      let storageEventCalled = false;
      const storage = {
        ...mockStorage,
        event: async () => {
          storageEventCalled = true;
        },
      } as unknown as AnalyzableRelay;
      const nsfwRelay = new Relay(storage, {
        relayUrl: "wss://relay.test/",
        rejectNsfw: true,
        analyze: nsfwAnalyze(true),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "nsfw"]],
          content: "https://example.com/pic.jpg",
        },
        sk,
      );

      await nsfwRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "blocked: this relay does not accept NSFW content",
      ]);
      assert.equal(storageEventCalled, false);
    });

    it("should accept a non-NSFW event when rejectNsfw is on", async () => {
      const nsfwRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        rejectNsfw: true,
        analyze: nsfwAnalyze(false),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "nostr"]],
          content: "hello",
        },
        sk,
      );

      await nsfwRelay.handleEvent(mockWs, event);
      nsfwRelay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should accept NSFW events by default", async () => {
      const nsfwRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        analyze: nsfwAnalyze(true),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "nsfw"]],
          content: "https://example.com/pic.jpg",
        },
        sk,
      );

      await nsfwRelay.handleEvent(mockWs, event);
      nsfwRelay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });
  });

  describe("rejected kinds", () => {
    it("should reject an event whose kind is on the rejected list", async () => {
      let storageEventCalled = false;
      const storage = {
        ...mockStorage,
        event: async () => {
          storageEventCalled = true;
        },
      } as unknown as AnalyzableRelay;
      const rejectRelay = new Relay(storage, {
        relayUrl: "wss://relay.test/",
        rejectedKinds: new Set([13]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 13,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "sealed",
        },
        sk,
      );

      await rejectRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "blocked: kind 13 is not accepted by this relay",
      ]);
      assert.equal(storageEventCalled, false);
    });

    it("should accept an event whose kind is not on the rejected list", async () => {
      const rejectRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        rejectedKinds: new Set([13]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "hello",
        },
        sk,
      );

      await rejectRelay.handleEvent(mockWs, event);
      rejectRelay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should accept any kind when no kinds are rejected", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 13,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "sealed",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should accept zap receipts (9735) while rejecting zap requests (9734)", async () => {
      const rejectRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        rejectedKinds: new Set([13, 9734, 20013, 20014, 22242, 24242, 27235]),
      });

      const sk = generateSecretKey();

      // 9734 zap request is rejected (never meant to be published).
      const zapRequest = finalizeEvent(
        {
          kind: 9734,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "00".repeat(32)]],
          content: "",
        },
        sk,
      );
      await rejectRelay.handleEvent(mockWs, zapRequest);
      assert.deepEqual(sentMessages[0], [
        "OK",
        zapRequest.id,
        false,
        "blocked: kind 9734 is not accepted by this relay",
      ]);

      sentMessages.length = 0;

      // 9735 zap receipt IS published and stored.
      const zapReceipt = finalizeEvent(
        {
          kind: 9735,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "00".repeat(32)]],
          content: "",
        },
        sk,
      );
      await rejectRelay.handleEvent(mockWs, zapReceipt);
      rejectRelay.flushBroadcasts();
      assert.deepEqual(sentMessages[0], ["OK", zapReceipt.id, true, ""]);
    });
  });

  describe("handleReq", () => {
    it("should accept valid REQ and send events with EOSE", async () => {
      const sk = generateSecretKey();
      const mockEvents: NostrEvent[] = [
        finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: "Event 1",
          },
          sk,
        ),
      ];

      mockStorage.query = async () => mockEvents;

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "EVENT");
      assert.equal(sentMessages[0][1], "sub1");
      // Check the event fields
      const sentEvent = sentMessages[0][2] as NostrEvent;
      assert.equal(sentEvent.id, mockEvents[0].id);
      assert.equal(sentEvent.content, mockEvents[0].content);
      assert.deepEqual(sentMessages[1], ["EOSE", "sub1"]);
      assert.equal(mockWs.data.subscriptions.size, 1);
      assert.ok(mockWs.data.subscriptions.has("sub1"));
    });

    it("should send EOSE even when no events match", async () => {
      mockStorage.query = async () => [];

      const filters: Filter[] = [{ kinds: [999] }];
      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["EOSE", "sub1"]);
      assert.equal(mockWs.data.subscriptions.size, 1);
    });

    it("should reject when subscription limit reached", async () => {
      // Fill up subscriptions to the limit
      for (let i = 0; i < 20; i++) {
        mockWs.data.subscriptions.add(`sub${i}`);
      }

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleReq(mockWs, "sub21", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "CLOSED",
        "sub21",
        "rate-limited: too many subscriptions",
      ]);
      assert.equal(mockWs.data.subscriptions.size, 20); // Not added
    });

    it("should send CLOSED on validation error", async () => {
      const filters: Filter[] = []; // Empty filters - invalid

      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "CLOSED");
      assert.equal(sentMessages[0][1], "sub1");
      assert.ok((sentMessages[0][2] as string).includes("non-empty array"));
    });

    it("should handle query errors gracefully", async () => {
      mockStorage.query = async () => {
        throw new Error("Query failed");
      };

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "CLOSED",
        "sub1",
        "error: Query failed",
      ]);
    });

    it("should store subscription on success", async () => {
      mockStorage.query = async () => [];

      const filters: Filter[] = [{ kinds: [1], authors: ["abc"] }];
      await relay.handleReq(mockWs, "sub1", filters);

      assert.ok(mockWs.data.subscriptions.has("sub1"));
    });

    it("should yield to the event loop while sending a large REQ result", async () => {
      // Generate 120 events (well over REQ_SEND_CHUNK=50) so the send loop
      // crosses the yield boundary at least twice.
      const sk = generateSecretKey();
      const mockEvents: NostrEvent[] = [];
      for (let i = 0; i < 120; i++) {
        mockEvents.push(
          finalizeEvent(
            {
              kind: 1,
              created_at: Math.floor(Date.now() / 1000),
              tags: [],
              content: `Event ${i}`,
            },
            sk,
          ),
        );
      }
      mockStorage.query = async () => mockEvents;

      // Schedule a setImmediate callback that runs only if the REQ send loop
      // yields. If the loop is fully synchronous, this callback will not fire
      // until after handleReq's await chain unwinds.
      let interleaved = false;
      let eventsSentBeforeInterleave = 0;
      const reqPromise = relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);

      // Race a setImmediate against the REQ completion. If the REQ yields,
      // the setImmediate callback fires before EOSE, and at that point we
      // should see some but not all events already sent.
      const yieldPromise = new Promise<void>((resolve) => {
        setImmediate(() => {
          interleaved = true;
          eventsSentBeforeInterleave = sentMessages.length;
          resolve();
        });
      });

      await Promise.race([reqPromise, yieldPromise]);
      await reqPromise;

      assert.equal(interleaved, true, "REQ send loop did not yield");
      // Some events were sent before the yield, and more were sent after.
      // The exact count depends on scheduling but we should have at least
      // one chunk (50) and fewer than the total + EOSE.
      assert.ok(
        eventsSentBeforeInterleave > 0 &&
          eventsSentBeforeInterleave < mockEvents.length + 1,
        `expected partial progress at yield, got ${eventsSentBeforeInterleave} of ${mockEvents.length}`,
      );
      // After completion, all events + EOSE were sent.
      assert.equal(sentMessages.length, mockEvents.length + 1);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
    });
  });

  describe("handleCount", () => {
    it("should return count when storage supports it", async () => {
      mockStorage.count = async () => ({ count: 42 });

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 42 });
    });

    it("should return count with approximate flag for multiple filters", async () => {
      mockStorage.count = async (filters: Filter[]) => ({
        count: 1000,
        approximate: filters.length > 1 ? true : undefined,
      });

      const filters: Filter[] = [{ kinds: [1] }, { kinds: [7] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 1000, approximate: true });
    });

    it("should not set approximate flag for single filter", async () => {
      mockStorage.count = async (filters: Filter[]) => ({
        count: 42,
        approximate: filters.length > 1 ? true : undefined,
      });

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 42 });
    });

    it("should send CLOSED when storage does not support count", async () => {
      // Remove count method from storage
      mockStorage.count = undefined;

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "CLOSED");
      assert.equal(sentMessages[0][1], "count1");
      assert.ok((sentMessages[0][2] as string).includes("COUNT not supported"));
    });

    it("should send CLOSED on validation error (empty filters)", async () => {
      mockStorage.count = async () => ({ count: 0 });

      const filters: Filter[] = []; // Empty filters - invalid
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "CLOSED");
      assert.equal(sentMessages[0][1], "count1");
      assert.ok((sentMessages[0][2] as string).includes("non-empty array"));
    });

    it("should handle count errors gracefully", async () => {
      mockStorage.count = async () => {
        throw new Error("Count failed");
      };

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "CLOSED",
        "count1",
        "error: Count failed",
      ]);
    });
  });

  describe("handleClose", () => {
    it("should remove subscription", () => {
      // Add a subscription
      mockWs.data.subscriptions.add("sub1");

      relay.handleClose(mockWs, "sub1");

      assert.equal(mockWs.data.subscriptions.size, 0);
    });

    it("should not error when closing non-existent subscription", () => {
      assert.doesNotThrow(() => {
        relay.handleClose(mockWs, "nonexistent");
      });
    });
  });

  describe("handleMessage", () => {
    it("should handle EVENT message", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Test",
        },
        sk,
      );

      const message = JSON.stringify(["EVENT", event]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], event.id);
    });

    it("should handle REQ message", async () => {
      mockStorage.query = async () => [];

      const message = JSON.stringify(["REQ", "sub1", { kinds: [1] }]);
      await relay.handleMessage(mockWs, message);

      assert.ok(sentMessages.length > 0);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
    });

    it("should handle COUNT message", async () => {
      mockStorage.count = async () => ({ count: 5 });

      const message = JSON.stringify(["COUNT", "count1", { kinds: [1] }]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 5 });
    });

    it("should handle CLOSE message", async () => {
      mockWs.data.subscriptions.add("sub1");

      const message = JSON.stringify(["CLOSE", "sub1"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(mockWs.data.subscriptions.size, 0);
    });

    it("should reject invalid JSON", async () => {
      const message = "not valid json";
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("failed to process message"),
      );
    });

    it("should reject non-array message", async () => {
      const message = JSON.stringify({ type: "EVENT" });
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("non-empty JSON array"),
      );
    });

    it("should reject empty array", async () => {
      const message = JSON.stringify([]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("non-empty JSON array"),
      );
    });

    it("should reject unknown message type", async () => {
      const message = JSON.stringify(["UNKNOWN", "param"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("unknown message type"),
      );
    });

    it("should reject EVENT with wrong parameter count", async () => {
      const message = JSON.stringify(["EVENT"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("exactly 1 parameter"));
    });

    describe("EVENT payload schema validation", () => {
      // A well-formed EVENT payload with a valid 64-hex id. Individual tests
      // mutate a single field to prove validation catches it.
      const validIdHex = "a".repeat(64);
      const validPubkey = "b".repeat(64);
      const validSig = "c".repeat(128);
      const baseEvent = () => ({
        id: validIdHex,
        pubkey: validPubkey,
        created_at: 1_700_000_000,
        kind: 1,
        tags: [],
        content: "hi",
        sig: validSig,
      });

      it("rejects EVENT with non-object payload (string)", async () => {
        const message = JSON.stringify(["EVENT", "not an event"]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
        assert.ok((sentMessages[0][1] as string).includes("schema validation"));
      });

      it("rejects EVENT with null payload", async () => {
        const message = JSON.stringify(["EVENT", null]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
      });

      it("rejects EVENT with missing id (no OK reply, falls back to NOTICE)", async () => {
        const bad = baseEvent();
        delete (bad as { id?: string }).id;
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
      });

      it("replies OK/false when id is valid-looking but other fields fail", async () => {
        const bad = { ...baseEvent(), kind: "not-a-number" };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.deepEqual(sentMessages[0], [
          "OK",
          validIdHex,
          false,
          "invalid: event failed schema validation",
        ]);
      });

      it("rejects EVENT with short id", async () => {
        const bad = { ...baseEvent(), id: "abc" };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        // id isn't 64-hex, so fallback to NOTICE
        assert.equal(sentMessages[0][0], "NOTICE");
      });

      it("rejects EVENT with tags as string", async () => {
        const bad = { ...baseEvent(), tags: "lol" };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("rejects EVENT with non-string tag element", async () => {
        const bad = { ...baseEvent(), tags: [["e", 123]] };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("rejects EVENT with missing sig", async () => {
        const bad = baseEvent();
        delete (bad as { sig?: string }).sig;
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("rejects EVENT with non-integer created_at", async () => {
        const bad = { ...baseEvent(), created_at: 1.5 };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("does not pollute Object.prototype from __proto__ payload", async () => {
        // Object literal written as JSON so __proto__ is treated as a data
        // key by JSON.parse, not as the literal prototype slot.
        const message = `["EVENT", {
          "id": "${validIdHex}",
          "pubkey": "${validPubkey}",
          "created_at": 1700000000,
          "kind": 1,
          "tags": "bogus",
          "content": "",
          "sig": "${validSig}",
          "__proto__": { "polluted": true }
        }]`;
        await relay.handleMessage(mockWs, message);
        // Schema rejects the event entirely (tags is a string, not array)...
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
        // ...and critically, no pollution leaked into Object.prototype.
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
      });
    });

    describe("AUTH payload schema validation", () => {
      it("rejects AUTH with non-object payload", async () => {
        const message = JSON.stringify(["AUTH", "not an event"]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
        assert.ok((sentMessages[0][1] as string).includes("schema validation"));
      });

      it("rejects AUTH with malformed event (no OK reply for AUTH)", async () => {
        const bad = {
          id: "a".repeat(64),
          pubkey: "b".repeat(64),
          created_at: 1_700_000_000,
          kind: "not-a-number",
          tags: [],
          content: "",
          sig: "c".repeat(128),
        };
        const message = JSON.stringify(["AUTH", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
      });
    });

    describe("REQ/COUNT filter schema validation", () => {
      it("rejects REQ filter with non-array kinds", async () => {
        const message = JSON.stringify(["REQ", "sub1", { kinds: "nope" }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "sub1");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-numeric kind element", async () => {
        const message = JSON.stringify(["REQ", "sub1", { kinds: ["1"] }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-hex author", async () => {
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { authors: ["not-hex"] },
        ]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with short id", async () => {
        const message = JSON.stringify(["REQ", "sub1", { ids: ["deadbeef"] }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with negative limit", async () => {
        const message = JSON.stringify(["REQ", "sub1", { limit: -1 }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-numeric since", async () => {
        const message = JSON.stringify(["REQ", "sub1", { since: "yesterday" }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-string search", async () => {
        const message = JSON.stringify(["REQ", "sub1", { search: 123 }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter that is not an object", async () => {
        const message = JSON.stringify(["REQ", "sub1", "not-a-filter"]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects if ANY filter in the REQ is invalid (rest are ignored)", async () => {
        mockStorage.query = async () => [];
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { kinds: [1] }, // valid
          { kinds: ["2"] }, // invalid
        ]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("accepts REQ with valid filter", async () => {
        mockStorage.query = async () => [];
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { kinds: [1], authors: ["a".repeat(64)], limit: 10 },
        ]);
        await relay.handleMessage(mockWs, message);
        // Last message should be EOSE — no CLOSED with schema error.
        const last = sentMessages[sentMessages.length - 1];
        assert.equal(last[0], "EOSE");
      });

      it("rejects REQ with unknown top-level key", async () => {
        // NSchema.filter() rejects unrecognized top-level keys rather than
        // stripping them. Serving the subscription with the constraint
        // silently dropped would return more events than the client asked
        // for; NIP-01 sanctions CLOSED for a filter with unknown elements.
        mockStorage.query = async () => [];
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { kinds: [1], weirdKey: { nested: "attack" } },
        ]);
        await relay.handleMessage(mockWs, message);
        const last = sentMessages[sentMessages.length - 1];
        assert.equal(last[0], "CLOSED");
      });

      it("rejects REQ with a non-string tag filter value", async () => {
        // Regression: a `#E: [null]` filter used to pass validation and reach
        // OpenSearch, which rejected the query with a 400. Tag filter values
        // must be strings.
        mockStorage.query = async () => [];
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { kinds: [1111], "#E": [null] },
        ]);
        await relay.handleMessage(mockWs, message);
        const last = sentMessages[sentMessages.length - 1];
        assert.equal(last[0], "CLOSED");
      });

      it("rejects COUNT with invalid filter", async () => {
        const message = JSON.stringify([
          "COUNT",
          "c1",
          { authors: ["not-hex"] },
        ]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "c1");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });
    });

    describe("REQ/COUNT per-field max_filter_values cap", () => {
      let smallRelay: Relay;
      beforeEach(() => {
        smallRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
          maxFilterValues: 3,
        });
      });

      it("advertises max_filter_values in NIP-11 limitation", () => {
        const info = smallRelay.getRelayInfo();
        const lim = info.limitation as
          | { max_filter_values?: number }
          | undefined;
        assert.equal(lim?.max_filter_values, 3);
      });

      it("rejects REQ with authors array over cap", async () => {
        const authors = Array.from({ length: 4 }, (_, i) =>
          `${i}`.padStart(64, "0"),
        );
        const message = JSON.stringify(["REQ", "sub1", { authors }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "sub1");
        assert.ok((sentMessages[0][2] as string).includes("max_filter_values"));
        assert.ok((sentMessages[0][2] as string).includes("authors"));
      });

      it("rejects REQ with ids array over cap", async () => {
        const ids = Array.from({ length: 4 }, (_, i) =>
          `${i}`.padStart(64, "a"),
        );
        const message = JSON.stringify(["REQ", "sub1", { ids }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes('"ids"'));
      });

      it("rejects REQ with kinds array over cap", async () => {
        const kinds = [1, 2, 3, 4];
        const message = JSON.stringify(["REQ", "sub1", { kinds }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes('"kinds"'));
      });

      it("rejects REQ with #tag array over cap", async () => {
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { "#e": ["a", "b", "c", "d"] },
        ]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes('"#e"'));
      });

      it("accepts REQ with authors array exactly at cap", async () => {
        mockStorage.query = async () => [];
        const authors = Array.from({ length: 3 }, (_, i) =>
          `${i}`.padStart(64, "0"),
        );
        const message = JSON.stringify(["REQ", "sub1", { authors }]);
        await smallRelay.handleMessage(mockWs, message);
        const last = sentMessages[sentMessages.length - 1];
        assert.equal(last[0], "EOSE");
      });

      it("rejects COUNT when filter exceeds cap", async () => {
        const authors = Array.from({ length: 4 }, (_, i) =>
          `${i}`.padStart(64, "0"),
        );
        const message = JSON.stringify(["COUNT", "c1", { authors }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "c1");
        assert.ok((sentMessages[0][2] as string).includes("max_filter_values"));
      });

      it("default cap is 5000 when not configured", () => {
        const defaultRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
        });
        const info = defaultRelay.getRelayInfo();
        const lim = info.limitation as
          | { max_filter_values?: number }
          | undefined;
        assert.equal(lim?.max_filter_values, 5000);
      });
    });

    describe("NIP-11 limitation accuracy", () => {
      it("advertises max_event_tags matching the constructor option", () => {
        const customRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
          maxEventTags: 1234,
        });
        const lim = customRelay.getRelayInfo().limitation as
          | { max_event_tags?: number }
          | undefined;
        assert.equal(lim?.max_event_tags, 1234);
      });

      it("defaults max_event_tags to 5000 when unset", () => {
        const defaultRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
        });
        const lim = defaultRelay.getRelayInfo().limitation as
          | { max_event_tags?: number }
          | undefined;
        assert.equal(lim?.max_event_tags, 5000);
      });

      it("advertises max_limit matching the constructor option", () => {
        const customRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
          maxLimit: 250,
        });
        const lim = customRelay.getRelayInfo().limitation as
          | { max_limit?: number }
          | undefined;
        assert.equal(lim?.max_limit, 250);
      });

      it("defaults max_limit to 1000 when unset", () => {
        const defaultRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
        });
        const lim = defaultRelay.getRelayInfo().limitation as
          | { max_limit?: number }
          | undefined;
        assert.equal(lim?.max_limit, 1000);
      });

      it("does not advertise max_content_length (not enforced beyond max_message_length)", () => {
        const defaultRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
        });
        const lim = defaultRelay.getRelayInfo().limitation as
          | Record<string, unknown>
          | undefined;
        assert.ok(lim, "limitation object is present");
        assert.ok(
          !("max_content_length" in (lim as object)),
          "max_content_length should not be advertised",
        );
      });
    });

    it("should reject REQ with missing parameters", async () => {
      const message = JSON.stringify(["REQ", "sub1"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("at least 1 filter"));
    });

    it("should reject COUNT with missing parameters", async () => {
      const message = JSON.stringify(["COUNT", "count1"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("at least 1 filter"));
    });

    it("should reject CLOSE with wrong parameter count", async () => {
      const message = JSON.stringify(["CLOSE"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("exactly 1 parameter"));
    });

    it("should handle Buffer messages", async () => {
      mockStorage.query = async () => [];

      const messageStr = JSON.stringify(["REQ", "sub1", { kinds: [1] }]);
      const buffer = Buffer.from(messageStr);
      await relay.handleMessage(mockWs, buffer);

      assert.ok(sentMessages.length > 0);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
    });
  });

  describe("handleOpen", () => {
    it("should generate AUTH challenge but not send it on connection open", () => {
      relay.handleOpen(mockWs);

      // No messages should be sent on connection open
      assert.equal(sentMessages.length, 0);
      // Challenge should be generated and stored in connection data
      assert.equal(typeof mockWs.data.challenge, "string");
      assert.ok(mockWs.data.challenge.length > 0);
      // Challenge should not be marked as sent
      assert.equal(mockWs.data.challengeSent, false);
    });
  });

  describe("per-connection inflight cap", () => {
    it("should serialize EVENT processing on one connection past the cap", async () => {
      // Build a relay with a small cap and a slow analyze so we can observe
      // that the (cap+1)th event waits for the first to complete.
      const CAP = 2;
      let analyzeInflight = 0;
      let peakInflight = 0;
      const releaseFns: Array<() => void> = [];

      const cappedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        maxInflightPerConn: CAP,
        analyze: () => {
          analyzeInflight++;
          if (analyzeInflight > peakInflight) peakInflight = analyzeInflight;
          return new Promise((resolve) => {
            releaseFns.push(() => {
              analyzeInflight--;
              resolve({ verified: true });
            });
          });
        },
      });

      const sk = generateSecretKey();
      const messages: string[] = [];
      for (let i = 0; i < 5; i++) {
        const ev = finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: `event ${i}`,
          },
          sk,
        );
        messages.push(JSON.stringify(["EVENT", ev]));
      }

      // Fire-and-forget all 5 messages.
      const pending = messages.map((m) => cappedRelay.handleMessage(mockWs, m));

      // Let microtasks settle so the first CAP analyze() calls fire.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(
        analyzeInflight,
        CAP,
        `expected only ${CAP} concurrent analyze() calls, got ${analyzeInflight}`,
      );
      assert.equal(
        peakInflight,
        CAP,
        `peak concurrent analyze() should never exceed cap, got ${peakInflight}`,
      );

      // Release the first batch. Each release lets the next waiter through.
      while (releaseFns.length > 0) {
        const next = releaseFns.shift();
        if (!next) break;
        next();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      }

      await Promise.all(pending);

      // All 5 events should have been processed (OK responses sent).
      const okMessages = sentMessages.filter((m) => m[0] === "OK");
      assert.equal(okMessages.length, 5);
      assert.equal(
        peakInflight,
        CAP,
        "cap should have been respected throughout",
      );
    });

    it("should not gate REQ behind the EVENT inflight cap", async () => {
      // EVENTs hold the cap; a REQ on the same socket must still complete.
      const CAP = 1;
      const releaseFns: Array<() => void> = [];

      const cappedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        maxInflightPerConn: CAP,
        analyze: () =>
          new Promise((resolve) => {
            releaseFns.push(() => resolve({ verified: true }));
          }),
      });

      mockStorage.query = async () => [];

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "blocker",
        },
        sk,
      );

      // Start an EVENT that will hold the cap until we release.
      const eventPromise = cappedRelay.handleMessage(
        mockWs,
        JSON.stringify(["EVENT", event]),
      );

      // Let the EVENT acquire the semaphore.
      await new Promise((resolve) => setImmediate(resolve));

      // Now send a REQ on the same socket — it must complete without
      // waiting on the held EVENT.
      const reqPromise = cappedRelay.handleMessage(
        mockWs,
        JSON.stringify(["REQ", "subA", { kinds: [1] }]),
      );

      // REQ should finish promptly.
      await reqPromise;
      const lastBeforeRelease = sentMessages[sentMessages.length - 1];
      assert.equal(
        lastBeforeRelease[0],
        "EOSE",
        "REQ should have completed while EVENT was still gated",
      );

      // Now release the EVENT and await it.
      for (const fn of releaseFns) fn();
      await eventPromise;
    });
  });

  describe("handleCloseConnection", () => {
    it("should clear all subscriptions on connection close", () => {
      mockWs.data.subscriptions.add("sub1");
      mockWs.data.subscriptions.add("sub2");

      relay.handleCloseConnection(mockWs);

      assert.equal(mockWs.data.subscriptions.size, 0);
    });
  });

  describe("broadcast / live subscriptions", () => {
    /** Helper to create a mock WebSocket that records sent messages. */
    function createMockWs(): {
      ws: RelayConn;
      messages: unknown[][];
    } {
      const messages: unknown[][] = [];
      const ws = {
        send: (message: string) => {
          messages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Set(),
          challenge: "",
          authedPubkeys: new Set(),
        },
      } as unknown as RelayConn;
      return { ws, messages };
    }

    it("should broadcast event to matching subscription on another connection", async () => {
      // Subscriber
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0; // clear EOSE

      // Publisher (uses the default mockWs)
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "live!",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      // Subscriber should have received the event
      assert.equal(sub.messages.length, 1);
      assert.equal(sub.messages[0][0], "EVENT");
      assert.equal(sub.messages[0][1], "sub1");
      assert.equal((sub.messages[0][2] as NostrEvent).id, event.id);
    });

    it("should not broadcast to non-matching kind", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [7] }]); // wants kind 7
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "nope",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      // Subscriber should NOT receive the event
      assert.equal(sub.messages.length, 0);
    });

    it("should broadcast to subscription with matching author filter", async () => {
      const authorSk = generateSecretKey();
      const authorEvent = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        authorSk,
      );
      const authorPubkey = authorEvent.pubkey;

      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [1], authors: [authorPubkey] },
      ]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);

      // Event from matching author
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "match",
        },
        authorSk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();
      assert.equal(sub.messages.length, 1);
      assert.equal((sub.messages[0][2] as NostrEvent).id, event.id);

      // Event from different author — should NOT match
      sub.messages.length = 0;
      const otherSk = generateSecretKey();
      const otherEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "no match",
        },
        otherSk,
      );
      await relay.handleEvent(mockWs, otherEvent);
      relay.flushBroadcasts();
      assert.equal(sub.messages.length, 0);
    });

    it("should not broadcast after CLOSE", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Close the subscription
      relay.handleClose(sub.ws, "sub1");

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "too late",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sub.messages.length, 0);
    });

    it("should not broadcast after connection close", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Close the connection
      relay.handleCloseConnection(sub.ws);

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "gone",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sub.messages.length, 0);
    });

    it("should broadcast to multiple subscriptions on the same connection", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      await relay.handleReq(sub.ws, "sub2", [{ kinds: [1] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "multi",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      // Both subscriptions should receive the event
      const eventMessages = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 2);
      const subIds = eventMessages.map((m) => m[1]).sort();
      assert.deepEqual(subIds, ["sub1", "sub2"]);
    });

    it("should deduplicate when multiple filters in one subscription match", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      // Two filters that both match kind 1
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [1] },
        { kinds: [1, 7] },
      ]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "dedup",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      // Should only receive the event ONCE
      const eventMessages = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 1);
    });

    it("should broadcast to catchAll subscription with empty filter", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{}]); // empty filter = match everything
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 42,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "catch all",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sub.messages.length, 1);
      assert.equal(sub.messages[0][0], "EVENT");
      assert.equal((sub.messages[0][2] as NostrEvent).id, event.id);
    });

    it("should update broadcast filters when subscription is replaced", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Replace subscription to only want kind 7
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [7] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();

      // Kind 1 should NOT match anymore
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "old",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event1);
      relay.flushBroadcasts();
      assert.equal(sub.messages.length, 0);

      // Kind 7 should match now
      const event7 = finalizeEvent(
        {
          kind: 7,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "+",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event7);
      relay.flushBroadcasts();
      assert.equal(sub.messages.length, 1);
      assert.equal((sub.messages[0][2] as NostrEvent).id, event7.id);
    });

    it("should also broadcast to the publisher's own matching subscriptions", async () => {
      relay.handleOpen(mockWs);
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "echo",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      // Should have OK + EVENT (broadcast to own subscription)
      const okMsg = sentMessages.find((m) => m[0] === "OK");
      const eventMsg = sentMessages.find((m) => m[0] === "EVENT");
      assert.ok(okMsg);
      assert.ok(eventMsg);
      assert.equal(eventMsg[1], "sub1");
      assert.equal((eventMsg[2] as NostrEvent).id, event.id);
    });

    it("should not broadcast rejected events", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);

      // Submit an event with a bad signature
      const event = {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: "bad sig",
        sig: "c".repeat(128),
      } as NostrEvent;
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      // Subscriber should NOT receive a rejected event
      assert.equal(sub.messages.length, 0);
    });
  });

  describe("NIP-42 AUTH", () => {
    it("should handle AUTH message via handleMessage", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      const message = JSON.stringify(["AUTH", authEvent]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], authEvent.id);
      assert.equal(sentMessages[0][2], true);
    });

    it("should accept valid AUTH event and mark pubkey as authenticated", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", authEvent.id, true, ""]);
      assert.ok(relay.isAuthenticated(mockWs, authEvent.pubkey));
    });

    it("should allow multiple pubkeys to authenticate on the same connection", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();

      const authEvent1 = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk1,
      );

      const authEvent2 = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk2,
      );

      await relay.handleAuth(mockWs, authEvent1);
      await relay.handleAuth(mockWs, authEvent2);

      assert.ok(relay.isAuthenticated(mockWs, authEvent1.pubkey));
      assert.ok(relay.isAuthenticated(mockWs, authEvent2.pubkey));
    });

    it("should reject AUTH event with invalid signature", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const event = {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: 22242,
        tags: [
          ["relay", "wss://relay.test/"],
          ["challenge", mockWs.data.challenge],
        ],
        content: "",
        sig: "c".repeat(128),
      } as NostrEvent;

      await relay.handleAuth(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("signature verification"),
      );
      assert.ok(!relay.isAuthenticated(mockWs, event.pubkey));
    });

    it("should reject AUTH event with wrong kind", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 1, // wrong kind
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("kind 22242"));
      assert.ok(!relay.isAuthenticated(mockWs, authEvent.pubkey));
    });

    it("should reject AUTH event with timestamp too far in the past", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000) - 700, // ~11 minutes ago
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("timestamp"));
    });

    it("should reject AUTH event with wrong challenge", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", "wrong-challenge"],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("challenge does not match"),
      );
    });

    it("should reject AUTH event with missing relay tag", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["challenge", challenge]], // no relay tag
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("missing relay tag"));
    });

    it("should reject AUTH when relay URL does not match", async () => {
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com/",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      const badAuthEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://other-relay.example.com/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, badAuthEvent);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("relay URL does not match"),
      );
    });

    it("should accept AUTH with exact relay URL match", async () => {
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com/",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://myrelay.example.com/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, authEvent);
      assert.equal(sentMessages[0][2], true);
    });

    it("should tolerate optional trailing slash for root path", async () => {
      // Configured without trailing slash
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      // Client sends with trailing slash — should still match
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://myrelay.example.com/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, authEvent);
      assert.equal(sentMessages[0][2], true);
    });

    it("should not tolerate trailing slash leniency for non-root paths", async () => {
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com/custom-path",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      // Client sends with trailing slash on non-root path — should NOT match
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://myrelay.example.com/custom-path/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, authEvent);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("relay URL does not match"),
      );
    });

    it("should reject AUTH message with wrong parameter count", async () => {
      const message = JSON.stringify(["AUTH"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("exactly 1 parameter"));
    });
  });

  describe("NIP-70 protected events", () => {
    it("should reject protected event from unauthenticated client and send AUTH challenge", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "secret message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, protectedEvent);
      relay.flushBroadcasts();

      // AUTH challenge should be sent before the OK rejection
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[0][1], mockWs.data.challenge);
      assert.equal(sentMessages[1][0], "OK");
      assert.equal(sentMessages[1][1], protectedEvent.id);
      assert.equal(sentMessages[1][2], false);
      assert.ok((sentMessages[1][3] as string).includes("auth-required"));
    });

    it("should accept protected event from authenticated author", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      // Authenticate first
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );
      await relay.handleAuth(mockWs, authEvent);
      sentMessages.length = 0;

      // Now publish protected event
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "secret message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, protectedEvent);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], protectedEvent.id);
      assert.equal(sentMessages[0][2], true);
    });

    it("should reject protected event when authenticated as different pubkey", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();

      // Authenticate as sk1
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk1,
      );
      await relay.handleAuth(mockWs, authEvent);
      sentMessages.length = 0;

      // Try to publish protected event as sk2
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "not my event",
        },
        sk2,
      );

      await relay.handleEvent(mockWs, protectedEvent);
      relay.flushBroadcasts();

      // AUTH challenge is sent lazily before the rejection
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][2], false);
      assert.ok((sentMessages[1][3] as string).includes("auth-required"));
    });

    it("should accept non-protected event from unauthenticated client", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const normalEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "public message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, normalEvent);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], true);
    });

    it("should not treat tags with extra elements as protected", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      // ["-", "something"] is NOT a protection tag — must be exactly ["-"]
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-", "not-a-protection-tag"]],
          content: "normal message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], true);
    });

    it("should handle protected event via handleMessage", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "secret",
        },
        sk,
      );

      const message = JSON.stringify(["EVENT", protectedEvent]);
      await relay.handleMessage(mockWs, message);

      // AUTH challenge should be sent before the OK rejection
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "OK");
      assert.equal(sentMessages[1][2], false);
      assert.ok((sentMessages[1][3] as string).includes("auth-required"));
    });
  });

  describe("NIP-40 expiration", () => {
    it("should include NIP-40 in supported NIPs", () => {
      const info = relay.getRelayInfo();
      assert.ok(info.supported_nips?.includes(40));
    });

    it("should reject an event that is already expired", async () => {
      const sk = generateSecretKey();
      const pastTimestamp = String(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
      const expiredEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) - 7200,
          tags: [["expiration", pastTimestamp]],
          content: "This has expired",
        },
        sk,
      );

      await relay.handleEvent(mockWs, expiredEvent);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], expiredEvent.id);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("expired"));
    });

    it("should accept an event with a future expiration", async () => {
      const sk = generateSecretKey();
      const futureTimestamp = String(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["expiration", futureTimestamp]],
          content: "Not expired yet",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should accept an event with no expiration tag", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "No expiration",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should not broadcast an expired event", async () => {
      // Create a subscriber
      const sub = {
        send: (message: string) => {
          sentMessages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Set(),
          challenge: "",
          authedPubkeys: new Set(),
        },
      } as unknown as RelayConn;

      relay.handleOpen(sub);
      mockStorage.query = async () => [];
      await relay.handleReq(sub, "sub1", [{ kinds: [1] }]);
      sentMessages.length = 0;

      // Publish an expired event
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const expiredEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) - 7200,
          tags: [["expiration", String(Math.floor(Date.now() / 1000) - 3600)]],
          content: "Expired broadcast",
        },
        sk,
      );

      await relay.handleEvent(mockWs, expiredEvent);
      relay.flushBroadcasts();

      // The event should be rejected, so no EVENT message to subscriber
      const eventMessages = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 0);
    });
  });

  describe("clampUntil", () => {
    it("should set until to current time when not provided", () => {
      const before = Math.floor(Date.now() / 1000);
      const result = clampUntil({ kinds: [1] });
      const after = Math.floor(Date.now() / 1000);
      const { until } = result;
      assert.ok(until !== undefined);
      assert.ok(until >= before);
      assert.ok(until <= after);
    });

    it("should add fuzz to until when provided", () => {
      const before = Math.floor(Date.now() / 1000);
      const result = clampUntil({ kinds: [1] }, 60);
      const after = Math.floor(Date.now() / 1000);
      const { until } = result;
      assert.ok(until !== undefined);
      assert.ok(until >= before + 60);
      assert.ok(until <= after + 60);
    });

    it("should not override an explicit until", () => {
      const filter = { kinds: [1], until: 9999999999 };
      const result = clampUntil(filter);
      assert.equal(result.until, 9999999999);
    });

    it("should not set until when since is in the future", () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      const filter = { kinds: [1], since: future };
      const result = clampUntil(filter);
      assert.equal(result.until, undefined);
    });

    it("should set until when since is in the past", () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const before = Math.floor(Date.now() / 1000);
      const filter = { kinds: [1], since: past };
      const result = clampUntil(filter);
      const after = Math.floor(Date.now() / 1000);
      const { until } = result;
      assert.ok(until !== undefined);
      assert.ok(until >= before);
      assert.ok(until <= after);
    });

    it("should not mutate the original filter", () => {
      const filter: Filter = { kinds: [1] };
      const result = clampUntil(filter);
      assert.equal(filter.until, undefined);
      assert.notStrictEqual(result, filter);
    });
  });

  describe("clampLimit", () => {
    it("should apply the default when limit is omitted", () => {
      assert.equal(clampLimit({ kinds: [1] }, 100, 1000).limit, 100);
    });

    it("should cap a limit above the maximum", () => {
      assert.equal(
        clampLimit({ kinds: [1], limit: 5000 }, 100, 1000).limit,
        1000,
      );
    });

    it("should honor a limit below the maximum", () => {
      assert.equal(clampLimit({ kinds: [1], limit: 3 }, 100, 1000).limit, 3);
    });

    it("should preserve limit 0 (realtime-only subscription)", () => {
      assert.equal(clampLimit({ kinds: [1], limit: 0 }, 100, 1000).limit, 0);
    });

    it("should not mutate the original filter", () => {
      const filter: Filter = { kinds: [1] };
      const result = clampLimit(filter, 100, 1000);
      assert.equal(filter.limit, undefined);
      assert.notStrictEqual(result, filter);
    });

    it("should return the same object when the limit already conforms", () => {
      const filter: Filter = { kinds: [1], limit: 10 };
      assert.strictEqual(clampLimit(filter, 100, 1000), filter);
    });
  });

  describe("REQ limit enforcement", () => {
    it("applies defaultLimit and maxLimit to every REQ filter", async () => {
      const queried: Filter[][] = [];
      mockStorage.query = async (filters: Filter[]) => {
        queried.push(filters);
        return [];
      };

      const limitedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        defaultLimit: 5,
        maxLimit: 10,
      });

      await limitedRelay.handleReq(mockWs, "sub1", [
        { kinds: [1] },
        { kinds: [1], limit: 5000 },
        { kinds: [1], limit: 3 },
        { kinds: [1], limit: 0 },
      ]);

      assert.equal(queried.length, 1);
      assert.deepEqual(
        queried[0].map((f) => f.limit),
        [5, 10, 3, 0],
      );
    });

    it("caps defaultLimit at maxLimit when misconfigured", async () => {
      const queried: Filter[][] = [];
      mockStorage.query = async (filters: Filter[]) => {
        queried.push(filters);
        return [];
      };

      const limitedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        defaultLimit: 500,
        maxLimit: 10,
      });

      await limitedRelay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);

      assert.equal(queried[0][0].limit, 10);
    });

    it("does not cap the internal e-tag lookup behind a kind 5 deletion", async () => {
      const sk = generateSecretKey();
      const queried: Filter[][] = [];
      mockStorage.query = async (filters: Filter[]) => {
        queried.push(filters);
        return [];
      };

      const limitedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        defaultLimit: 5,
        maxLimit: 10,
      });

      const ids = Array.from({ length: 50 }, (_, i) =>
        createHash("sha256").update(`e${i}`).digest("hex"),
      );
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: ids.map((id) => ["e", id]),
          content: "",
        },
        sk,
      );

      await limitedRelay.handleEvent(mockWs, deletion);

      assert.equal(queried.length, 1);
      assert.equal(queried[0][0].limit, 50);
    });
  });

  describe("future event filtering", () => {
    it("should not return future events in REQ queries by default", async () => {
      const futureEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) + 3600,
          tags: [],
          content: "future",
        },
        generateSecretKey(),
      );

      // Mock storage returns the future event
      mockStorage.query = async (filters: Filter[]) => {
        // Verify that the filter has until set to approximately now
        const { until } = filters[0];
        assert.ok(until !== undefined);
        assert.ok(until <= Math.floor(Date.now() / 1000) + 1);
        return [futureEvent];
      };

      relay.handleOpen(mockWs);
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);

      // Should still get events from storage (storage decides what matches)
      const eventMessages = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 1);
    });

    it("should pass through explicit until to storage", async () => {
      const futureUntil = Math.floor(Date.now() / 1000) + 7200;

      mockStorage.query = async (filters: Filter[]) => {
        assert.equal(filters[0].until, futureUntil);
        return [];
      };

      relay.handleOpen(mockWs);
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1], until: futureUntil },
      ]);
    });

    it("should not set until when since is in the future", async () => {
      const futureSince = Math.floor(Date.now() / 1000) + 3600;

      mockStorage.query = async (filters: Filter[]) => {
        assert.equal(filters[0].until, undefined);
        assert.equal(filters[0].since, futureSince);
        return [];
      };

      relay.handleOpen(mockWs);
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1], since: futureSince },
      ]);
    });

    it("should not broadcast future events to subscriptions without explicit until", async () => {
      /** Helper to create a mock WebSocket that records sent messages. */
      function createMockWs(): {
        ws: RelayConn;
        messages: unknown[][];
      } {
        const messages: unknown[][] = [];
        const ws = {
          send: (message: string) => {
            messages.push(JSON.parse(message));
          },
          data: {
            subscriptions: new Set(),
            challenge: "",
            authedPubkeys: new Set(),
          },
        } as unknown as RelayConn;
        return { ws, messages };
      }

      // Subscriber with no until filter
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Publish a future-dated event
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const futureEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) + 3600,
          tags: [],
          content: "future event",
        },
        sk,
      );
      await relay.handleEvent(mockWs, futureEvent);
      relay.flushBroadcasts();

      // Subscriber should NOT receive the future event
      const eventMessages = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 0);
    });

    it("should reject future-dated ephemeral events with OK false", async () => {
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const futureEphemeral = finalizeEvent(
        {
          kind: 20000,
          created_at: Math.floor(Date.now() / 1000) + 3600,
          tags: [],
          content: "future ephemeral",
        },
        sk,
      );
      await relay.handleEvent(mockWs, futureEphemeral);
      relay.flushBroadcasts();

      const okMsg = sentMessages.find((m) => m[0] === "OK");
      assert.ok(okMsg);
      assert.equal(okMsg[1], futureEphemeral.id);
      assert.equal(okMsg[2], false);
      assert.ok(
        (okMsg[3] as string).includes("ephemeral event is in the future"),
      );
    });
  });

  describe("NIP-77 Negentropy sync", () => {
    /** Deterministic 64-char hex ID from a seed. */
    const syncId = (seed: string): string =>
      createHash("sha256").update(seed).digest("hex");

    /** A storage record for the mock syncable backend. */
    interface MockItem {
      created_at: number;
      id: string;
    }

    /** Attach queryItems/count to the mock storage. */
    const makeSyncable = (items: MockItem[]): { queryItemsCalls: Filter[] } => {
      const calls: Filter[] = [];
      const storage = mockStorage as AnalyzableRelay & {
        queryItems?: (
          filter: Filter,
          opts?: { maxItems?: number },
        ) => Promise<MockItem[]>;
      };
      storage.queryItems = async (filter, opts) => {
        calls.push(filter);
        const sorted = [...items].sort((a, b) =>
          a.created_at !== b.created_at
            ? a.created_at - b.created_at
            : a.id < b.id
              ? -1
              : 1,
        );
        // A limit selects the N newest (still returned ascending),
        // mirroring OpenSearchRelay.queryItems.
        const limited =
          typeof filter.limit === "number"
            ? sorted.slice(Math.max(0, sorted.length - filter.limit))
            : sorted;
        return limited.slice(0, opts?.maxItems ?? limited.length);
      };
      storage.count = async () => ({ count: items.length });
      return { queryItemsCalls: calls };
    };

    /** Build an initiator over a set of mock items. */
    const makeInitiator = (items: MockItem[]): Negentropy => {
      const vector = new NegentropyStorageVector();
      for (const item of items) {
        vector.insertHex(item.created_at, item.id);
      }
      vector.seal();
      return new Negentropy(vector);
    };

    /** Last message sent to the mock socket. */
    const lastMessage = (): unknown[] =>
      sentMessages[sentMessages.length - 1] as unknown[];

    it("should complete a full sync round-trip over NEG-OPEN/NEG-MSG", async () => {
      const shared = Array.from({ length: 100 }, (_, i) => ({
        created_at: 1000 + i,
        id: syncId(`shared-${i}`),
      }));
      const serverOnly = Array.from({ length: 10 }, (_, i) => ({
        created_at: 2000 + i,
        id: syncId(`server-${i}`),
      }));
      const clientOnly = Array.from({ length: 10 }, (_, i) => ({
        created_at: 3000 + i,
        id: syncId(`client-${i}`),
      }));

      makeSyncable([...shared, ...serverOnly]);
      const client = makeInitiator([...shared, ...clientOnly]);

      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1] },
          bytesToHex(client.initiate()),
        ]),
      );

      let response = lastMessage();
      assert.equal(response[0], "NEG-MSG");
      assert.equal(response[1], "neg1");

      let haveIds: string[] = [];
      let needIds: string[] = [];
      let rounds = 0;
      while (true) {
        rounds++;
        assert.ok(rounds < 50, "sync did not converge");
        const result = client.reconcile(hexToBytes(response[2] as string));
        haveIds = result.haveIds;
        needIds = result.needIds;
        if (result.message === null) break;
        await relay.handleMessage(
          mockWs,
          JSON.stringify(["NEG-MSG", "neg1", bytesToHex(result.message)]),
        );
        response = lastMessage();
        assert.equal(response[0], "NEG-MSG");
      }

      assert.deepEqual([...haveIds].sort(), clientOnly.map((i) => i.id).sort());
      assert.deepEqual([...needIds].sort(), serverOnly.map((i) => i.id).sort());
    });

    it("should pass limit through and clamp until on the sync filter", async () => {
      const { queryItemsCalls } = makeSyncable([]);
      const client = makeInitiator([]);

      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1], limit: 10 },
          bytesToHex(client.initiate()),
        ]),
      );

      assert.equal(queryItemsCalls.length, 1);
      assert.equal(queryItemsCalls[0].limit, 10);
      assert.ok(typeof queryItemsCalls[0].until === "number");
    });

    it("should sync only the N newest events when the filter has a limit", async () => {
      const serverItems = Array.from({ length: 50 }, (_, i) => ({
        created_at: 1000 + i,
        id: syncId(`limited-${i}`),
      }));
      makeSyncable(serverItems);
      // The count pre-check must be skipped when limit bounds the set:
      // a huge total count must not block the sync.
      mockStorage.count = async () => ({ count: 5_000_000 });

      const client = makeInitiator([]);
      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1], limit: 10 },
          bytesToHex(client.initiate()),
        ]),
      );

      const response = lastMessage();
      assert.equal(response[0], "NEG-MSG");

      const result = client.reconcile(hexToBytes(response[2] as string));
      assert.equal(result.message, null);
      assert.deepEqual(
        [...result.needIds].sort(),
        serverItems
          .slice(-10)
          .map((i) => i.id)
          .sort(),
      );
    });

    it("should reply NEG-ERR blocked when storage is not syncable", async () => {
      const client = makeInitiator([]);
      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1] },
          bytesToHex(client.initiate()),
        ]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.equal(msg[1], "neg1");
      assert.ok((msg[2] as string).startsWith("blocked:"));
    });

    it("should reply NEG-ERR invalid on a malformed filter", async () => {
      makeSyncable([]);
      await relay.handleMessage(
        mockWs,
        JSON.stringify(["NEG-OPEN", "neg1", { kinds: "bogus" }, "61"]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("invalid:"));
    });

    it("should reply NEG-ERR invalid on non-hex initial message", async () => {
      makeSyncable([]);
      await relay.handleMessage(
        mockWs,
        JSON.stringify(["NEG-OPEN", "neg1", { kinds: [1] }, "zznothex"]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("invalid:"));
    });

    it("should reply NEG-ERR blocked with the cap when the query is too big", async () => {
      makeSyncable([]);
      mockStorage.count = async () => ({ count: 50 });

      const cappedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        negentropyMaxRecords: 10,
      });
      const client = makeInitiator([]);

      await cappedRelay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1] },
          bytesToHex(client.initiate()),
        ]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("blocked:"));
      assert.equal(msg[3], 10);
    });

    it("should reply NEG-ERR closed for NEG-MSG on an unknown subscription", async () => {
      await relay.handleMessage(
        mockWs,
        JSON.stringify(["NEG-MSG", "nope", "61"]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.equal(msg[1], "nope");
      assert.ok((msg[2] as string).startsWith("closed:"));
    });

    it("should release the session on NEG-CLOSE", async () => {
      makeSyncable([{ created_at: 1000, id: syncId("a") }]);
      const client = makeInitiator([]);

      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1] },
          bytesToHex(client.initiate()),
        ]),
      );
      assert.equal(lastMessage()[0], "NEG-MSG");

      await relay.handleMessage(mockWs, JSON.stringify(["NEG-CLOSE", "neg1"]));
      await relay.handleMessage(
        mockWs,
        JSON.stringify(["NEG-MSG", "neg1", "61"]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("closed:"));
    });

    it("should release sessions when the connection closes", async () => {
      makeSyncable([{ created_at: 1000, id: syncId("a") }]);
      const client = makeInitiator([]);

      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1] },
          bytesToHex(client.initiate()),
        ]),
      );
      assert.equal(lastMessage()[0], "NEG-MSG");

      relay.handleCloseConnection(mockWs);

      await relay.handleMessage(
        mockWs,
        JSON.stringify(["NEG-MSG", "neg1", "61"]),
      );
      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("closed:"));
    });

    it("should replace an existing session when NEG-OPEN reuses the subscription ID", async () => {
      makeSyncable([{ created_at: 1000, id: syncId("a") }]);

      for (let i = 0; i < 2; i++) {
        const client = makeInitiator([]);
        await relay.handleMessage(
          mockWs,
          JSON.stringify([
            "NEG-OPEN",
            "neg1",
            { kinds: [1] },
            bytesToHex(client.initiate()),
          ]),
        );
        assert.equal(lastMessage()[0], "NEG-MSG");
      }
    });

    it("should reject sync of auth-protected kinds without authentication", async () => {
      makeSyncable([]);
      const authRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        authKinds: new Set([4]),
      });
      const client = makeInitiator([]);

      await authRelay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [4] },
          bytesToHex(client.initiate()),
        ]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("auth-required:"));
    });

    it("should enforce the per-connection sync session cap", async () => {
      makeSyncable([]);

      for (let i = 0; i < 20; i++) {
        const client = makeInitiator([]);
        await relay.handleMessage(
          mockWs,
          JSON.stringify([
            "NEG-OPEN",
            `neg${i}`,
            { kinds: [1] },
            bytesToHex(client.initiate()),
          ]),
        );
        assert.equal(lastMessage()[0], "NEG-MSG");
      }

      const client = makeInitiator([]);
      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg20",
          { kinds: [1] },
          bytesToHex(client.initiate()),
        ]),
      );

      const msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("blocked:"));
    });

    it("should reply NEG-ERR and drop the session on a malformed NEG-MSG", async () => {
      makeSyncable([{ created_at: 1000, id: syncId("a") }]);
      const client = makeInitiator([]);

      await relay.handleMessage(
        mockWs,
        JSON.stringify([
          "NEG-OPEN",
          "neg1",
          { kinds: [1] },
          bytesToHex(client.initiate()),
        ]),
      );
      assert.equal(lastMessage()[0], "NEG-MSG");

      await relay.handleMessage(
        mockWs,
        JSON.stringify(["NEG-MSG", "neg1", "nothex"]),
      );
      let msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("invalid:"));

      // Session is gone now.
      await relay.handleMessage(
        mockWs,
        JSON.stringify(["NEG-MSG", "neg1", "61"]),
      );
      msg = lastMessage();
      assert.equal(msg[0], "NEG-ERR");
      assert.ok((msg[2] as string).startsWith("closed:"));
    });
  });
});

describe("Relay with authKinds", () => {
  let relay: Relay;
  let mockStorage: AnalyzableRelay;
  let mockWs: RelayConn;
  let sentMessages: unknown[][];

  beforeEach(() => {
    sentMessages = [];
    console.error = () => {};
    console.log = () => {};

    mockStorage = {
      event: async (_event: NostrEvent) => {},
      query: async (_filters: Filter[]) => [],
      remove: async (_filters: Filter[]) => {},
    } as unknown as AnalyzableRelay;

    mockWs = {
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
      data: {
        subscriptions: new Set(),
        challenge: "test-challenge",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as RelayConn;

    relay = new Relay(mockStorage, {
      relayUrl: "wss://relay.test/",
      authKinds: new Set([4, 1059]),
    });
  });

  afterEach(() => {
    console.error = () => {};
    console.log = () => {};
  });

  describe("REQ with auth kinds", () => {
    it("should reject REQ for auth kind without authors or #p (unauthenticated)", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [4] }]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.equal(sentMessages[1][1], "sub1");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject REQ for kind 1059 without authors or #p (unauthenticated)", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1059] }]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject REQ with auth kind and unauthenticated authors", async () => {
      mockStorage.query = async () => [];
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH"); // challenge sent
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject REQ with auth kind and unauthenticated #p", async () => {
      mockStorage.query = async () => [];
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1059], "#p": [pubkey] },
      ]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should allow REQ for auth kind with authenticated authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      // Authenticate the pubkey
      mockWs.data.authedPubkeys.add(pubkey);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      // Should get EOSE (no CLOSED)
      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
      assert.equal(eose[1], "sub1");
    });

    it("should allow REQ for auth kind with authenticated #p", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1059], "#p": [pubkey] },
      ]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
    });

    it("should reject when one of multiple authors is not authenticated", async () => {
      const sk1 = generateSecretKey();
      const pk1 = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk1,
      ).pubkey;
      const sk2 = generateSecretKey();
      const pk2 = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk2,
      ).pubkey;

      // Only authenticate pk1
      mockWs.data.authedPubkeys.add(pk1);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pk1, pk2] },
      ]);

      const closed = sentMessages.find((m) => m[0] === "CLOSED");
      assert.ok(closed);
      assert.ok((closed[2] as string).startsWith("auth-required:"));
    });

    it("should allow combined authors+#p filter when authenticated as all authors", async () => {
      const skMe = generateSecretKey();
      const me = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        skMe,
      ).pubkey;
      const skThem = generateSecretKey();
      const them = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        skThem,
      ).pubkey;

      // Conversation-scoped DM query: messages I sent to them.
      mockWs.data.authedPubkeys.add(me);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [me], "#p": [them] },
      ]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
      assert.ok(!sentMessages.find((m) => m[0] === "CLOSED"));
    });

    it("should allow combined authors+#p filter when authenticated as all #p recipients", async () => {
      const skMe = generateSecretKey();
      const me = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        skMe,
      ).pubkey;
      const skThem = generateSecretKey();
      const them = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        skThem,
      ).pubkey;

      // Conversation-scoped DM query: messages they sent to me.
      mockWs.data.authedPubkeys.add(me);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [them], "#p": [me] },
      ]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
      assert.ok(!sentMessages.find((m) => m[0] === "CLOSED"));
    });

    it("should reject combined authors+#p filter when neither list is fully authenticated", async () => {
      const skMe = generateSecretKey();
      const me = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        skMe,
      ).pubkey;
      const skA = generateSecretKey();
      const pkA = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        skA,
      ).pubkey;
      const skB = generateSecretKey();
      const pkB = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        skB,
      ).pubkey;

      // Authed as `me`, but authors is [me, pkA] (not fully authed) and
      // #p is [pkB] (not authed at all).
      mockWs.data.authedPubkeys.add(me);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [me, pkA], "#p": [pkB] },
      ]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should allow non-auth kinds without authentication", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
    });

    it("should pass through events from catch-all REQ (storage handles auth-kind exclusion)", async () => {
      const sk = generateSecretKey();
      const kind1Event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "public",
        },
        sk,
      );

      // Storage only returns non-auth-kind events for catch-all queries
      // (auth-kind exclusion is handled at the storage/OpenSearch level)
      mockStorage.query = async () => [kind1Event];
      await relay.handleReq(mockWs, "sub1", [{ authors: [kind1Event.pubkey] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 1);
    });

    it("should allow auth-kind events when explicitly requested with auth", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);

      const kind4Event = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "dm",
        },
        sk,
      );

      mockStorage.query = async () => [kind4Event];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 4);
    });
  });

  describe("COUNT with auth kinds", () => {
    it("should reject COUNT for auth kind without authors or #p (unauthenticated)", async () => {
      mockStorage.count = async () => ({ count: 10 });
      await relay.handleCount(mockWs, "c1", [{ kinds: [4] }]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject COUNT for auth kind with unauthenticated authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockStorage.count = async () => ({ count: 10 });
      await relay.handleCount(mockWs, "c1", [
        { kinds: [1059], authors: [pubkey] },
      ]);

      assert.equal(sentMessages.length, 2); // AUTH + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should allow COUNT for auth kind with authenticated authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);
      mockStorage.count = async () => ({ count: 5 });
      await relay.handleCount(mockWs, "c1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.deepEqual(sentMessages[0][2], { count: 5 });
    });

    it("should pass through catch-all COUNT (storage handles auth-kind exclusion)", async () => {
      mockStorage.count = async () => ({ count: 100 });

      await relay.handleCount(mockWs, "c1", [{ authors: ["abc".repeat(10)] }]);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal((sentMessages[0][2] as { count: number }).count, 100);
    });
  });

  describe("broadcast with auth kinds", () => {
    function createMockWs(): {
      ws: RelayConn;
      messages: unknown[][];
    } {
      const messages: unknown[][] = [];
      const ws = {
        send: (message: string) => {
          messages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Set(),
          challenge: "",
          challengeSent: false,
          authedPubkeys: new Set(),
        },
      } as unknown as RelayConn;
      return { ws, messages };
    }

    it("should not broadcast auth-kind events to catch-all subscriptions", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{}]); // catch-all
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "secret dm",
        },
        sk,
      );
      await relay.handleEvent(mockWs, dmEvent);
      relay.flushBroadcasts();

      // Subscriber with catch-all should NOT receive kind 4
      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);
    });

    it("should not broadcast auth-kind events to subscriptions that don't include auth kinds", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1, 7] }]); // no auth kinds
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const giftWrap = finalizeEvent(
        {
          kind: 1059,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "wrapped",
        },
        sk,
      );
      await relay.handleEvent(mockWs, giftWrap);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);
    });

    it("should broadcast auth-kind events to subscriptions that explicitly include the kind", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const sub = createMockWs();
      sub.ws.data.authedPubkeys.add(pubkey);
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "dm for subscriber",
        },
        sk,
      );
      await relay.handleEvent(mockWs, dmEvent);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 4);
    });

    it("should broadcast non-auth kinds normally", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "hello",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
    });
  });

  describe("REQ by ID for auth kinds", () => {
    it("should withhold auth-kind event and send AUTH challenge when unauthenticated", async () => {
      const sk = generateSecretKey();
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "recipient".padStart(64, "0")]],
          content: "secret dm",
        },
        sk,
      );

      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      // Event should be withheld, AUTH challenge sent, then CLOSED (not EOSE)
      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);

      const authMsg = sentMessages.find((m) => m[0] === "AUTH");
      assert.ok(authMsg, "AUTH challenge should be sent");

      const closed = sentMessages.find((m) => m[0] === "CLOSED");
      assert.ok(closed, "CLOSED should be sent");
      assert.equal(closed[1], "sub1");
      assert.ok((closed[2] as string).startsWith("auth-required:"));

      // No EOSE — subscription was closed
      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.equal(eose, undefined);
    });

    it("should return auth-kind event when authenticated as author", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "recipient".padStart(64, "0")]],
          content: "secret dm",
        },
        sk,
      );

      mockWs.data.authedPubkeys.add(pubkey);
      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).id, dmEvent.id);
    });

    it("should return auth-kind event when authenticated as p-tag recipient", async () => {
      const authorSk = generateSecretKey();
      const recipientSk = generateSecretKey();
      const recipientPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        recipientSk,
      ).pubkey;

      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", recipientPk]],
          content: "dm to recipient",
        },
        authorSk,
      );

      mockWs.data.authedPubkeys.add(recipientPk);
      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).id, dmEvent.id);
    });

    it("should withhold auth-kind event when authenticated as unrelated pubkey", async () => {
      const authorSk = generateSecretKey();
      const unrelatedSk = generateSecretKey();
      const unrelatedPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        unrelatedSk,
      ).pubkey;

      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "recipient".padStart(64, "0")]],
          content: "secret dm",
        },
        authorSk,
      );

      mockWs.data.authedPubkeys.add(unrelatedPk);
      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);

      // Gets CLOSED with auth-required, not EOSE
      const closed = sentMessages.find((m) => m[0] === "CLOSED");
      assert.ok(closed);
      assert.ok((closed[2] as string).startsWith("auth-required:"));
    });

    it("should return non-auth-kind event by ID without authentication", async () => {
      const sk = generateSecretKey();
      const noteEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "public note",
        },
        sk,
      );

      mockStorage.query = async () => [noteEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [noteEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).id, noteEvent.id);

      // No AUTH challenge
      const authMsg = sentMessages.find((m) => m[0] === "AUTH");
      assert.equal(authMsg, undefined);
    });

    it("should return kind 1059 gift wrap by ID when authenticated as p-tag recipient", async () => {
      const authorSk = generateSecretKey();
      const recipientSk = generateSecretKey();
      const recipientPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        recipientSk,
      ).pubkey;

      const giftWrap = finalizeEvent(
        {
          kind: 1059,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", recipientPk]],
          content: "wrapped content",
        },
        authorSk,
      );

      mockWs.data.authedPubkeys.add(recipientPk);
      mockStorage.query = async () => [giftWrap];
      await relay.handleReq(mockWs, "sub1", [{ ids: [giftWrap.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 1059);
    });
  });

  describe("broadcast auth-kind event to authorized subscriber only", () => {
    function createMockWs(): {
      ws: RelayConn;
      messages: unknown[][];
    } {
      const messages: unknown[][] = [];
      const ws = {
        send: (message: string) => {
          messages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Set(),
          challenge: "",
          challengeSent: false,
          authedPubkeys: new Set(),
        },
      } as unknown as RelayConn;
      return { ws, messages };
    }

    it("should not broadcast auth-kind event to subscriber who is not a party", async () => {
      const authorSk = generateSecretKey();

      // Subscriber is authenticated as a different pubkey
      const subscriberSk = generateSecretKey();
      const subscriberPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        subscriberSk,
      ).pubkey;

      const sub = createMockWs();
      sub.ws.data.authedPubkeys.add(subscriberPk);
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      // Subscribe to kind 4 for subscriber's own pubkey
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [4], authors: [subscriberPk] },
      ]);
      sub.messages.length = 0;

      // Author sends a DM to someone else (not the subscriber)
      relay.handleOpen(mockWs);
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "someone_else".padStart(64, "0")]],
          content: "not for you",
        },
        authorSk,
      );
      await relay.handleEvent(mockWs, dmEvent);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);
    });
  });

  describe("mixed filters", () => {
    it("should reject when any filter in the array contains auth kind without auth", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1] }, // fine
        { kinds: [4] }, // needs auth
      ]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should allow mixed kinds in a single filter when auth kind has valid authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1, 4], authors: [pubkey] },
      ]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
    });
  });
});

describe("Relay with masterPubkeys", () => {
  let relay: Relay;
  let mockStorage: AnalyzableRelay;
  let mockWs: RelayConn;
  let sentMessages: unknown[][];
  let masterPk: string;
  let strangerPk: string;
  /** Opts captured from the last storage.query / storage.count call. */
  let lastQueryOpts: { includeAuthKinds?: boolean } | undefined;
  let lastCountOpts: { includeAuthKinds?: boolean } | undefined;

  beforeEach(() => {
    sentMessages = [];
    console.error = () => {};
    console.log = () => {};
    lastQueryOpts = undefined;
    lastCountOpts = undefined;

    mockStorage = {
      event: async (_event: NostrEvent) => {},
      query: async (
        _filters: Filter[],
        opts?: { includeAuthKinds?: boolean },
      ) => {
        lastQueryOpts = opts;
        return [];
      },
      count: async (
        _filters: Filter[],
        opts?: { includeAuthKinds?: boolean },
      ) => {
        lastCountOpts = opts;
        return { count: 7 };
      },
      remove: async (_filters: Filter[]) => {},
    } as unknown as AnalyzableRelay;

    masterPk = finalizeEvent(
      { kind: 1, created_at: 0, tags: [], content: "" },
      generateSecretKey(),
    ).pubkey;
    strangerPk = finalizeEvent(
      { kind: 1, created_at: 0, tags: [], content: "" },
      generateSecretKey(),
    ).pubkey;

    mockWs = {
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
      data: {
        subscriptions: new Set(),
        challenge: "test-challenge",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as RelayConn;

    relay = new Relay(mockStorage, {
      relayUrl: "wss://relay.test/",
      authKinds: new Set([4, 1059]),
      masterPubkeys: new Set([masterPk]),
    });
  });

  afterEach(() => {
    console.error = () => {};
    console.log = () => {};
  });

  it("lets a master REQ auth kinds for other users without authing as them", async () => {
    mockWs.data.authedPubkeys.add(masterPk);

    // Filter targets a stranger's DMs; the connection never authed as them.
    await relay.handleReq(mockWs, "sub1", [
      { kinds: [4], authors: [strangerPk] },
    ]);

    assert.ok(sentMessages.find((m) => m[0] === "EOSE"));
    assert.ok(!sentMessages.find((m) => m[0] === "CLOSED"));
  });

  it("does not exclude auth kinds from a master's catch-all query", async () => {
    mockWs.data.authedPubkeys.add(masterPk);

    await relay.handleReq(mockWs, "sub1", [{}]);

    assert.equal(lastQueryOpts?.includeAuthKinds, true);
    assert.ok(sentMessages.find((m) => m[0] === "EOSE"));
  });

  it("returns auth-kind events a master is not a party to", async () => {
    mockWs.data.authedPubkeys.add(masterPk);

    const dm = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", strangerPk]],
        content: "between two strangers",
      },
      generateSecretKey(),
    );
    mockStorage.query = async () => [dm];

    await relay.handleReq(mockWs, "sub1", [{ ids: [dm.id] }]);

    const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
    assert.equal(eventMsgs.length, 1);
    assert.equal((eventMsgs[0][2] as NostrEvent).id, dm.id);
    assert.ok(!sentMessages.find((m) => m[0] === "CLOSED"));
  });

  it("lets a master COUNT auth kinds for other users", async () => {
    mockWs.data.authedPubkeys.add(masterPk);

    await relay.handleCount(mockWs, "c1", [
      { kinds: [4], authors: [strangerPk] },
    ]);

    assert.equal(lastCountOpts?.includeAuthKinds, true);
    const count = sentMessages.find((m) => m[0] === "COUNT");
    assert.ok(count);
    assert.deepEqual(count[2], { count: 7 });
  });

  it("broadcasts auth-kind events to a master's catch-all subscription", async () => {
    mockWs.data.authedPubkeys.add(masterPk);
    relay.handleOpen(mockWs);
    await relay.handleReq(mockWs, "sub1", [{}]); // catch-all
    sentMessages.length = 0;

    const sender = {
      send: () => {},
      data: {
        subscriptions: new Set(),
        challenge: "",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as RelayConn;
    relay.handleOpen(sender);
    const dm = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", strangerPk]],
        content: "not addressed to the master",
      },
      generateSecretKey(),
    );
    await relay.handleEvent(sender, dm);
    relay.flushBroadcasts();

    const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
    assert.equal(eventMsgs.length, 1);
    assert.equal((eventMsgs[0][2] as NostrEvent).kind, 4);
  });

  it("still gates a connection that has not authed as a master", async () => {
    // Authed only as a non-master pubkey.
    mockWs.data.authedPubkeys.add(strangerPk);

    await relay.handleReq(mockWs, "sub1", [{ kinds: [4] }]);

    const closed = sentMessages.find((m) => m[0] === "CLOSED");
    assert.ok(closed);
    // Authenticated, but not as a party — gated with "restricted:", and the
    // storage query is never reached with the auth-kind bypass.
    assert.ok((closed[2] as string).startsWith("restricted:"));
    assert.notEqual(lastQueryOpts?.includeAuthKinds, true);
  });
});

describe("Relay with authorExemptKinds", () => {
  let relay: Relay;
  let mockStorage: AnalyzableRelay;
  let mockWs: RelayConn;
  let sentMessages: unknown[][];
  let streamSk: Uint8Array;
  let streamPk: string;
  let otherPk: string;

  const wrapBy = (sk: Uint8Array, recipient: string) =>
    finalizeEvent(
      {
        kind: 1059,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", recipient]],
        content: "sealed",
      },
      sk,
    );

  beforeEach(() => {
    sentMessages = [];
    console.error = () => {};
    console.log = () => {};

    mockStorage = {
      event: async (_event: NostrEvent) => {},
      query: async (_filters: Filter[]) => [],
      count: async (_filters: Filter[]) => ({ count: 7 }),
      remove: async (_filters: Filter[]) => {},
    } as unknown as AnalyzableRelay;

    streamSk = generateSecretKey();
    streamPk = finalizeEvent(
      { kind: 1, created_at: 0, tags: [], content: "" },
      streamSk,
    ).pubkey;
    otherPk = finalizeEvent(
      { kind: 1, created_at: 0, tags: [], content: "" },
      generateSecretKey(),
    ).pubkey;

    mockWs = {
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
      data: {
        subscriptions: new Set(),
        challenge: "test-challenge",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as RelayConn;

    relay = new Relay(mockStorage, {
      relayUrl: "wss://relay.test/",
      authKinds: new Set([4, 1059]),
      authorExemptKinds: new Set([1059]),
    });
  });

  afterEach(() => {
    console.error = () => {};
    console.log = () => {};
  });

  it("serves an unauthenticated REQ for kind 1059 scoped to explicit authors", async () => {
    const wrap = wrapBy(streamSk, otherPk);
    mockStorage.query = async () => [wrap];

    await relay.handleReq(mockWs, "sub1", [
      { kinds: [1059], authors: [streamPk] },
    ]);

    const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
    assert.equal(eventMsgs.length, 1);
    assert.equal((eventMsgs[0][2] as NostrEvent).id, wrap.id);
    assert.ok(sentMessages.find((m) => m[0] === "EOSE"));
    assert.ok(!sentMessages.find((m) => m[0] === "CLOSED"));
    assert.ok(!sentMessages.find((m) => m[0] === "AUTH"));
  });

  it("serves an unauthenticated COUNT for kind 1059 scoped to explicit authors", async () => {
    await relay.handleCount(mockWs, "c1", [
      { kinds: [1059], authors: [streamPk] },
    ]);

    const count = sentMessages.find((m) => m[0] === "COUNT");
    assert.ok(count);
    assert.deepEqual(count[2], { count: 7 });
    assert.ok(!sentMessages.find((m) => m[0] === "CLOSED"));
  });

  it("still rejects an unauthenticated #p-scoped REQ for kind 1059", async () => {
    await relay.handleReq(mockWs, "sub1", [{ kinds: [1059], "#p": [otherPk] }]);

    assert.equal(sentMessages[0][0], "AUTH");
    const closed = sentMessages.find((m) => m[0] === "CLOSED");
    assert.ok(closed);
    assert.ok((closed[2] as string).startsWith("auth-required:"));
  });

  it("still rejects an unauthenticated authors-scoped REQ for a non-exempt auth kind", async () => {
    await relay.handleReq(mockWs, "sub1", [
      { kinds: [4], authors: [streamPk] },
    ]);

    const closed = sentMessages.find((m) => m[0] === "CLOSED");
    assert.ok(closed);
    assert.ok((closed[2] as string).startsWith("auth-required:"));
  });

  it("still rejects when the filter mixes exempt and non-exempt auth kinds", async () => {
    await relay.handleReq(mockWs, "sub1", [
      { kinds: [4, 1059], authors: [streamPk] },
    ]);

    const closed = sentMessages.find((m) => m[0] === "CLOSED");
    assert.ok(closed);
    assert.ok((closed[2] as string).startsWith("auth-required:"));
  });

  it("still rejects an unauthenticated REQ for kind 1059 without authors", async () => {
    await relay.handleReq(mockWs, "sub1", [{ kinds: [1059] }]);

    const closed = sentMessages.find((m) => m[0] === "CLOSED");
    assert.ok(closed);
    assert.ok((closed[2] as string).startsWith("auth-required:"));
  });

  it("withholds a returned wrap whose author the filter did not name", async () => {
    // Fail closed if storage produces an auth-kind event outside the
    // exemption's grant (e.g. via another filter in the same REQ).
    const foreign = wrapBy(generateSecretKey(), otherPk);
    mockStorage.query = async () => [foreign];

    await relay.handleReq(mockWs, "sub1", [
      { kinds: [1059], authors: [streamPk] },
    ]);

    assert.ok(!sentMessages.find((m) => m[0] === "EVENT"));
    const closed = sentMessages.find((m) => m[0] === "CLOSED");
    assert.ok(closed);
    assert.ok((closed[2] as string).startsWith("auth-required:"));
  });

  it("broadcasts a live wrap to an unauthenticated authors-scoped subscription", async () => {
    relay.handleOpen(mockWs);
    await relay.handleReq(mockWs, "sub1", [
      { kinds: [1059], authors: [streamPk] },
    ]);
    sentMessages.length = 0;

    const sender = {
      send: () => {},
      data: {
        subscriptions: new Set(),
        challenge: "",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as RelayConn;
    relay.handleOpen(sender);

    // A wrap by the subscribed stream address is delivered; a wrap by a
    // different author is not.
    await relay.handleEvent(sender, wrapBy(streamSk, otherPk));
    await relay.handleEvent(sender, wrapBy(generateSecretKey(), otherPk));
    relay.flushBroadcasts();

    const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
    assert.equal(eventMsgs.length, 1);
    assert.equal((eventMsgs[0][2] as NostrEvent).pubkey, streamPk);
  });

  it("does not exempt anything when the option is unset", async () => {
    const gated = new Relay(mockStorage, {
      relayUrl: "wss://relay.test/",
      authKinds: new Set([4, 1059]),
    });

    await gated.handleReq(mockWs, "sub1", [
      { kinds: [1059], authors: [streamPk] },
    ]);

    const closed = sentMessages.find((m) => m[0] === "CLOSED");
    assert.ok(closed);
    assert.ok((closed[2] as string).startsWith("auth-required:"));
  });
});
