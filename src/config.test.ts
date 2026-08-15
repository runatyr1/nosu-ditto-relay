import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Config } from "./config.ts";

/** Minimum env required to construct a Config (RELAY_URL and NOSTR_NSEC are mandatory). */
function baseEnv(overrides?: [string, string][]): Map<string, string> {
  const entries: [string, string][] = [
    ["RELAY_URL", "wss://relay.example.com/"],
    [
      "NOSTR_NSEC",
      "nsec1l2xejwnzu9sjl9ve3eryktge5u05esdez9ll3wt9gly9n7yraq4sph4kgh",
    ],
    ...(overrides ?? []),
  ];
  return new Map(entries);
}

describe("Config", () => {
  describe("port", () => {
    it("should return default port 13131 when PORT is not set", () => {
      const config = new Config(baseEnv());
      assert.equal(config.port, 13131);
    });

    it("should return the port from environment when valid", () => {
      const config = new Config(baseEnv([["PORT", "8080"]]));
      assert.equal(config.port, 8080);
    });

    it("should throw error when PORT is not a number", () => {
      assert.throws(() => new Config(baseEnv([["PORT", "invalid"]])), {
        message: "PORT must be a valid port number (1-65535).",
      });
    });

    it("should throw error when PORT is below 1", () => {
      assert.throws(() => new Config(baseEnv([["PORT", "0"]])), {
        message: "PORT must be a valid port number (1-65535).",
      });
    });

    it("should throw error when PORT is above 65535", () => {
      assert.throws(() => new Config(baseEnv([["PORT", "65536"]])), {
        message: "PORT must be a valid port number (1-65535).",
      });
    });

    it("should accept PORT at boundary values", () => {
      const configMin = new Config(baseEnv([["PORT", "1"]]));
      assert.equal(configMin.port, 1);

      const configMax = new Config(baseEnv([["PORT", "65535"]]));
      assert.equal(configMax.port, 65535);
    });
  });

  describe("ipHeader", () => {
    it("should default to undefined (use socket address)", () => {
      const config = new Config(baseEnv());
      assert.equal(config.ipHeader, undefined);
    });

    it("should return the header name when set", () => {
      const config = new Config(baseEnv([["IP_HEADER", "CF-Connecting-IP"]]));
      assert.equal(config.ipHeader, "CF-Connecting-IP");
    });

    it("should treat an empty string as unset", () => {
      const config = new Config(baseEnv([["IP_HEADER", ""]]));
      assert.equal(config.ipHeader, undefined);
    });
  });

  describe("logLevel", () => {
    it("should default to info", () => {
      const config = new Config(baseEnv());
      assert.equal(config.logLevel, "info");
    });

    it("should accept and lowercase a valid level", () => {
      const config = new Config(baseEnv([["LOG_LEVEL", "DEBUG"]]));
      assert.equal(config.logLevel, "debug");
    });

    it("should throw on an invalid level", () => {
      assert.throws(
        () => new Config(baseEnv([["LOG_LEVEL", "verbose"]])),
        /LOG_LEVEL must be one of/,
      );
    });
  });

  describe("relayUrl", () => {
    it("should throw an error when RELAY_URL is not set", () => {
      const mockEnv = new Map([
        [
          "NOSTR_NSEC",
          "nsec1l2xejwnzu9sjl9ve3eryktge5u05esdez9ll3wt9gly9n7yraq4sph4kgh",
        ],
      ]);
      assert.throws(() => new Config(mockEnv), /RELAY_URL is required/);
    });

    it("should return the RELAY_URL from environment when set", () => {
      const config = new Config(baseEnv());
      assert.equal(config.relayUrl, "wss://relay.example.com/");
    });
  });

  describe("nostrSigner", () => {
    it("should throw an error when NOSTR_NSEC is not set", () => {
      const mockEnv = new Map([["RELAY_URL", "wss://relay.example.com/"]]);
      assert.throws(() => new Config(mockEnv), /NOSTR_NSEC is required/);
    });

    it("should return a NostrSigner when a valid nsec is provided", async () => {
      const config = new Config(baseEnv());
      const signer = config.nostrSigner;
      const pubkey = await signer.getPublicKey();
      assert.equal(typeof pubkey, "string");
      assert.equal(pubkey.length, 64);
    });

    it("should throw an error when the value is not an nsec", () => {
      const mockEnv = new Map([
        ["RELAY_URL", "wss://relay.example.com/"],
        [
          "NOSTR_NSEC",
          "npub1dpyfqvgf6cup9cx3tdnqrh0h33alsey5rtu34976sgxrag3286aqgnlshp",
        ],
      ]);
      assert.throws(() => new Config(mockEnv), /must be a valid nsec/);
    });
  });

  describe("trendsIntervalMs", () => {
    it("should default to 900000 (15 minutes)", () => {
      const config = new Config(baseEnv());
      assert.equal(config.trendsIntervalMs, 900_000);
    });

    it("should parse from environment", () => {
      const config = new Config(baseEnv([["TRENDS_INTERVAL_MS", "60000"]]));
      assert.equal(config.trendsIntervalMs, 60_000);
    });

    it("should allow 0 to disable", () => {
      const config = new Config(baseEnv([["TRENDS_INTERVAL_MS", "0"]]));
      assert.equal(config.trendsIntervalMs, 0);
    });
  });

  describe("preferredLanguages", () => {
    it("should return empty array when not set", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(config.preferredLanguages, []);
    });

    it("should parse comma-separated language codes", () => {
      const config = new Config(baseEnv([["DITTO_LANGUAGES", "en,pt,es"]]));
      assert.deepEqual(config.preferredLanguages, ["en", "pt", "es"]);
    });

    it("should filter out invalid language codes", () => {
      const config = new Config(
        baseEnv([["DITTO_LANGUAGES", "en,xyz,pt,123"]]),
      );
      assert.deepEqual(config.preferredLanguages, ["en", "pt"]);
    });

    it("should handle whitespace", () => {
      const config = new Config(baseEnv([["DITTO_LANGUAGES", "en , pt , es"]]));
      assert.deepEqual(config.preferredLanguages, ["en", "pt", "es"]);
    });
  });

  describe("historyEnabled", () => {
    it("should default to true", () => {
      const config = new Config(baseEnv());
      assert.equal(config.historyEnabled, true);
    });

    it("should be false when set to 'false'", () => {
      const config = new Config(baseEnv([["HISTORY_ENABLED", "false"]]));
      assert.equal(config.historyEnabled, false);
    });

    it("should be true when set to 'true'", () => {
      const config = new Config(baseEnv([["HISTORY_ENABLED", "true"]]));
      assert.equal(config.historyEnabled, true);
    });

    it("should accept '1' as true and '0' as false", () => {
      assert.equal(
        new Config(baseEnv([["HISTORY_ENABLED", "1"]])).historyEnabled,
        true,
      );
      assert.equal(
        new Config(baseEnv([["HISTORY_ENABLED", "0"]])).historyEnabled,
        false,
      );
    });
  });

  describe("historyKindsWhitelist", () => {
    it("should return undefined when not set", () => {
      const config = new Config(baseEnv());
      assert.equal(config.historyKindsWhitelist, undefined);
    });

    it("should parse comma-separated kind numbers", () => {
      const config = new Config(
        baseEnv([["HISTORY_KINDS_WHITELIST", "0,3,30023"]]),
      );
      assert.deepEqual(config.historyKindsWhitelist, new Set([0, 3, 30023]));
    });

    it("should handle whitespace", () => {
      const config = new Config(
        baseEnv([["HISTORY_KINDS_WHITELIST", " 0 , 3 , 30023 "]]),
      );
      assert.deepEqual(config.historyKindsWhitelist, new Set([0, 3, 30023]));
    });

    it("should filter out non-numbers", () => {
      const config = new Config(
        baseEnv([["HISTORY_KINDS_WHITELIST", "0,abc,3"]]),
      );
      assert.deepEqual(config.historyKindsWhitelist, new Set([0, 3]));
    });

    it("should return undefined for empty string", () => {
      const config = new Config(baseEnv([["HISTORY_KINDS_WHITELIST", ""]]));
      assert.equal(config.historyKindsWhitelist, undefined);
    });
  });

  describe("authKinds", () => {
    it("should default to kinds 4 and 1059", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(config.authKinds, new Set([4, 1059]));
    });

    it("should parse comma-separated kind numbers", () => {
      const config = new Config(baseEnv([["AUTH_KINDS", "4,1059,104"]]));
      assert.deepEqual(config.authKinds, new Set([4, 1059, 104]));
    });

    it("should return empty set for empty string", () => {
      const config = new Config(baseEnv([["AUTH_KINDS", ""]]));
      assert.deepEqual(config.authKinds, new Set());
    });

    it("should handle whitespace", () => {
      const config = new Config(baseEnv([["AUTH_KINDS", " 4 , 1059 "]]));
      assert.deepEqual(config.authKinds, new Set([4, 1059]));
    });

    it("should filter out non-numbers", () => {
      const config = new Config(baseEnv([["AUTH_KINDS", "4,abc,1059"]]));
      assert.deepEqual(config.authKinds, new Set([4, 1059]));
    });
  });

  describe("authorExemptKinds", () => {
    it("should default to kind 1059", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(config.authorExemptKinds, new Set([1059]));
    });

    it("should parse comma-separated kind numbers", () => {
      const config = new Config(
        baseEnv([["AUTH_AUTHOR_EXEMPT_KINDS", "1059,104"]]),
      );
      assert.deepEqual(config.authorExemptKinds, new Set([1059, 104]));
    });

    it("should return empty set for empty string", () => {
      const config = new Config(baseEnv([["AUTH_AUTHOR_EXEMPT_KINDS", ""]]));
      assert.deepEqual(config.authorExemptKinds, new Set());
    });
  });

  describe("masterPubkeys", () => {
    const hex =
      "4b1b7f0d17e5ee24ccd091afacfe7923329c21387f1f3ee14c3cf3fa31e2a813";

    it("should default to an empty set when not set", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(config.masterPubkeys, new Set());
    });

    it("should parse a comma-separated list of hex pubkeys", () => {
      const config = new Config(
        baseEnv([["MASTER_PUBKEYS", `${hex},${"a".repeat(64)}`]]),
      );
      assert.deepEqual(config.masterPubkeys, new Set([hex, "a".repeat(64)]));
    });

    it("should lowercase and trim hex entries", () => {
      const config = new Config(
        baseEnv([["MASTER_PUBKEYS", ` ${hex.toUpperCase()} `]]),
      );
      assert.deepEqual(config.masterPubkeys, new Set([hex]));
    });

    it("should return an empty set for an empty string", () => {
      const config = new Config(baseEnv([["MASTER_PUBKEYS", ""]]));
      assert.deepEqual(config.masterPubkeys, new Set());
    });

    it("should throw on a non-hex entry", () => {
      assert.throws(
        () => new Config(baseEnv([["MASTER_PUBKEYS", "not-a-pubkey"]])),
        /MASTER_PUBKEYS/,
      );
    });

    it("should throw on an npub entry", () => {
      assert.throws(
        () =>
          new Config(
            baseEnv([
              [
                "MASTER_PUBKEYS",
                "npub1fvdh7rghuhhzfnxsjxh6elneyvefcgfc0u0nac2v8nel5v0z4qfs7ak6zx",
              ],
            ]),
          ),
        /MASTER_PUBKEYS/,
      );
    });
  });

  describe("wotSeedPubkeys", () => {
    const hex =
      "4b1b7f0d17e5ee24ccd091afacfe7923329c21387f1f3ee14c3cf3fa31e2a813";

    it("should default to an empty set when not set", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(config.wotSeedPubkeys, new Set());
    });

    it("should parse a comma-separated list of hex pubkeys", () => {
      const config = new Config(
        baseEnv([["WOT_SEED_PUBKEYS", `${hex},${"a".repeat(64)}`]]),
      );
      assert.deepEqual(config.wotSeedPubkeys, new Set([hex, "a".repeat(64)]));
    });

    it("should lowercase and trim hex entries", () => {
      const config = new Config(
        baseEnv([["WOT_SEED_PUBKEYS", ` ${hex.toUpperCase()} `]]),
      );
      assert.deepEqual(config.wotSeedPubkeys, new Set([hex]));
    });

    it("should return an empty set for an empty string", () => {
      const config = new Config(baseEnv([["WOT_SEED_PUBKEYS", ""]]));
      assert.deepEqual(config.wotSeedPubkeys, new Set());
    });

    it("should throw on a non-hex entry", () => {
      assert.throws(
        () => new Config(baseEnv([["WOT_SEED_PUBKEYS", "not-a-pubkey"]])),
        /WOT_SEED_PUBKEYS/,
      );
    });
  });

  describe("bannedHashtags", () => {
    it("should default to an empty set when not set", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(config.bannedHashtags, new Set());
    });

    it("should parse comma-separated hashtags", () => {
      const config = new Config(
        baseEnv([["BANNED_HASHTAGS", "spam,nsfw,scam"]]),
      );
      assert.deepEqual(
        config.bannedHashtags,
        new Set(["spam", "nsfw", "scam"]),
      );
    });

    it("should lowercase hashtags", () => {
      const config = new Config(baseEnv([["BANNED_HASHTAGS", "Spam,NSFW"]]));
      assert.deepEqual(config.bannedHashtags, new Set(["spam", "nsfw"]));
    });

    it("should trim whitespace and drop empty entries", () => {
      const config = new Config(
        baseEnv([["BANNED_HASHTAGS", " spam , , nsfw "]]),
      );
      assert.deepEqual(config.bannedHashtags, new Set(["spam", "nsfw"]));
    });

    it("should return empty set for empty string", () => {
      const config = new Config(baseEnv([["BANNED_HASHTAGS", ""]]));
      assert.deepEqual(config.bannedHashtags, new Set());
    });
  });

  describe("rejectedKinds", () => {
    it("should default to seal/auth/zap-request artifact kinds", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(
        config.rejectedKinds,
        new Set([13, 9734, 20013, 20014, 22242, 24242, 27235]),
      );
    });

    it("should parse comma-separated kind numbers", () => {
      const config = new Config(baseEnv([["REJECTED_KINDS", "13,3,7"]]));
      assert.deepEqual(config.rejectedKinds, new Set([13, 3, 7]));
    });

    it("should return empty set for empty string", () => {
      const config = new Config(baseEnv([["REJECTED_KINDS", ""]]));
      assert.deepEqual(config.rejectedKinds, new Set());
    });

    it("should handle whitespace", () => {
      const config = new Config(baseEnv([["REJECTED_KINDS", " 13 , 3 "]]));
      assert.deepEqual(config.rejectedKinds, new Set([13, 3]));
    });

    it("should filter out non-numbers", () => {
      const config = new Config(baseEnv([["REJECTED_KINDS", "13,abc,3"]]));
      assert.deepEqual(config.rejectedKinds, new Set([13, 3]));
    });
  });

  describe("maxMessageLength", () => {
    it("should default to 4_000_000 when not set", () => {
      const config = new Config(baseEnv());
      assert.equal(config.maxMessageLength, 4_000_000);
    });

    it("should parse from environment", () => {
      const config = new Config(
        baseEnv([["RELAY_MAX_MESSAGE_LENGTH", "128000"]]),
      );
      assert.equal(config.maxMessageLength, 128_000);
    });

    it("should throw when not a number", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_MESSAGE_LENGTH", "invalid"]])),
        /RELAY_MAX_MESSAGE_LENGTH/,
      );
    });

    it("should throw when zero", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_MESSAGE_LENGTH", "0"]])),
        /RELAY_MAX_MESSAGE_LENGTH/,
      );
    });

    it("should throw when negative", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_MESSAGE_LENGTH", "-1"]])),
        /RELAY_MAX_MESSAGE_LENGTH/,
      );
    });
  });

  describe("maxFilterValues", () => {
    it("should default to 20000 when not set", () => {
      const config = new Config(baseEnv());
      assert.equal(config.maxFilterValues, 20_000);
    });

    it("should parse from environment", () => {
      const config = new Config(baseEnv([["RELAY_MAX_FILTER_VALUES", "2500"]]));
      assert.equal(config.maxFilterValues, 2500);
    });

    it("should throw when not a number", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_FILTER_VALUES", "nope"]])),
        /RELAY_MAX_FILTER_VALUES/,
      );
    });

    it("should throw when zero", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_FILTER_VALUES", "0"]])),
        /RELAY_MAX_FILTER_VALUES/,
      );
    });

    it("should throw when negative", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_FILTER_VALUES", "-1"]])),
        /RELAY_MAX_FILTER_VALUES/,
      );
    });
  });

  describe("maxLimit / defaultLimit", () => {
    it("should default to 1000 / 100 when not set", () => {
      const config = new Config(baseEnv());
      assert.equal(config.maxLimit, 1000);
      assert.equal(config.defaultLimit, 100);
    });

    it("should parse maxLimit from environment", () => {
      const config = new Config(baseEnv([["RELAY_MAX_LIMIT", "2000"]]));
      assert.equal(config.maxLimit, 2000);
    });

    it("should parse defaultLimit from environment", () => {
      const config = new Config(baseEnv([["RELAY_DEFAULT_LIMIT", "50"]]));
      assert.equal(config.defaultLimit, 50);
    });

    it("should throw when maxLimit is not a number", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_LIMIT", "nope"]])),
        /RELAY_MAX_LIMIT/,
      );
    });

    it("should throw when maxLimit is zero", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_LIMIT", "0"]])),
        /RELAY_MAX_LIMIT/,
      );
    });

    it("should throw when defaultLimit is not a number", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_DEFAULT_LIMIT", "nope"]])),
        /RELAY_DEFAULT_LIMIT/,
      );
    });

    it("should throw when defaultLimit exceeds maxLimit", () => {
      assert.throws(
        () =>
          new Config(
            baseEnv([
              ["RELAY_MAX_LIMIT", "100"],
              ["RELAY_DEFAULT_LIMIT", "500"],
            ]),
          ),
        /RELAY_DEFAULT_LIMIT must not exceed RELAY_MAX_LIMIT/,
      );
    });
  });

  describe("tagValueMaxCountPerName", () => {
    it("should default to 5000 when not set", () => {
      const config = new Config(baseEnv());
      assert.equal(config.tagValueMaxCountPerName, 5000);
    });
    it("should parse from environment", () => {
      const config = new Config(
        baseEnv([["RELAY_TAG_VALUE_MAX_COUNT_PER_NAME", "1024"]]),
      );
      assert.equal(config.tagValueMaxCountPerName, 1024);
    });

    it("should throw when not a number", () => {
      assert.throws(
        () =>
          new Config(baseEnv([["RELAY_TAG_VALUE_MAX_COUNT_PER_NAME", "nope"]])),
        /RELAY_TAG_VALUE_MAX_COUNT_PER_NAME/,
      );
    });

    it("should throw when zero", () => {
      assert.throws(
        () =>
          new Config(baseEnv([["RELAY_TAG_VALUE_MAX_COUNT_PER_NAME", "0"]])),
        /RELAY_TAG_VALUE_MAX_COUNT_PER_NAME/,
      );
    });

    it("should throw when negative", () => {
      assert.throws(
        () =>
          new Config(baseEnv([["RELAY_TAG_VALUE_MAX_COUNT_PER_NAME", "-1"]])),
        /RELAY_TAG_VALUE_MAX_COUNT_PER_NAME/,
      );
    });
  });

  describe("historyKindsExcluded", () => {
    it("should default to NIP-85 kinds (30382-30385)", () => {
      const config = new Config(baseEnv());
      assert.deepEqual(
        config.historyKindsExcluded,
        new Set([30382, 30383, 30384, 30385]),
      );
    });

    it("should parse comma-separated kind numbers", () => {
      const config = new Config(
        baseEnv([["HISTORY_KINDS_EXCLUDED", "3,10002"]]),
      );
      assert.deepEqual(config.historyKindsExcluded, new Set([3, 10002]));
    });

    it("should return empty set for empty string", () => {
      const config = new Config(baseEnv([["HISTORY_KINDS_EXCLUDED", ""]]));
      assert.deepEqual(config.historyKindsExcluded, new Set());
    });
  });

  describe("bulkMaxQueue", () => {
    it("should default to 5000", () => {
      const config = new Config(baseEnv());
      assert.equal(config.bulkMaxQueue, 5_000);
    });

    it("should parse a positive integer", () => {
      const config = new Config(baseEnv([["BULK_MAX_QUEUE", "1000"]]));
      assert.equal(config.bulkMaxQueue, 1000);
    });

    it("should throw when zero", () => {
      assert.throws(
        () => new Config(baseEnv([["BULK_MAX_QUEUE", "0"]])),
        /BULK_MAX_QUEUE/,
      );
    });

    it("should throw when negative", () => {
      assert.throws(
        () => new Config(baseEnv([["BULK_MAX_QUEUE", "-1"]])),
        /BULK_MAX_QUEUE/,
      );
    });
  });

  describe("maxInflightPerConn", () => {
    it("should default to 32", () => {
      const config = new Config(baseEnv());
      assert.equal(config.maxInflightPerConn, 32);
    });

    it("should parse a positive integer", () => {
      const config = new Config(
        baseEnv([["RELAY_MAX_INFLIGHT_PER_CONN", "64"]]),
      );
      assert.equal(config.maxInflightPerConn, 64);
    });

    it("should throw when zero", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_INFLIGHT_PER_CONN", "0"]])),
        /RELAY_MAX_INFLIGHT_PER_CONN/,
      );
    });

    it("should throw when negative", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_INFLIGHT_PER_CONN", "-1"]])),
        /RELAY_MAX_INFLIGHT_PER_CONN/,
      );
    });

    it("should throw when not a number", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_MAX_INFLIGHT_PER_CONN", "lots"]])),
        /RELAY_MAX_INFLIGHT_PER_CONN/,
      );
    });
  });

  describe("negentropyMaxRecords", () => {
    it("should default to 1000000", () => {
      const config = new Config(baseEnv());
      assert.equal(config.negentropyMaxRecords, 1_000_000);
    });

    it("should parse a positive integer", () => {
      const config = new Config(
        baseEnv([["RELAY_NEGENTROPY_MAX_RECORDS", "50000"]]),
      );
      assert.equal(config.negentropyMaxRecords, 50_000);
    });

    it("should throw when zero", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_NEGENTROPY_MAX_RECORDS", "0"]])),
        /RELAY_NEGENTROPY_MAX_RECORDS/,
      );
    });

    it("should throw when negative", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_NEGENTROPY_MAX_RECORDS", "-1"]])),
        /RELAY_NEGENTROPY_MAX_RECORDS/,
      );
    });

    it("should throw when not a number", () => {
      assert.throws(
        () => new Config(baseEnv([["RELAY_NEGENTROPY_MAX_RECORDS", "lots"]])),
        /RELAY_NEGENTROPY_MAX_RECORDS/,
      );
    });
  });
});
