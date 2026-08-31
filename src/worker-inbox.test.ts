import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { onWorkerMessage } from "./worker-inbox.ts";

/**
 * The module installs its buffering handler on `self` (the global scope) at
 * import time. These tests drive that handler directly — dispatching real
 * worker messages needs a worker, which protocol-pool.test.ts covers end to
 * end.
 */
// biome-ignore lint/suspicious/noExplicitAny: test-only access to the global handler
const globalScope = globalThis as any;

function deliver(data: unknown): void {
  globalScope.onmessage({ data } as MessageEvent);
}

describe("onWorkerMessage", () => {
  it("replays messages that arrived before the handler registered", () => {
    deliver({ t: "first" });
    deliver({ t: "second" });

    const seen: unknown[] = [];
    onWorkerMessage<{ t: string }>((event) => seen.push(event.data.t));

    // In arrival order, and nothing lost.
    assert.deepEqual(seen, ["first", "second"]);

    // Later messages go straight through.
    deliver({ t: "third" });
    assert.deepEqual(seen, ["first", "second", "third"]);
  });

  it("routes to the most recently registered handler", () => {
    const seen: unknown[] = [];
    onWorkerMessage<{ t: string }>((event) => seen.push(event.data.t));
    deliver({ t: "after" });
    assert.deepEqual(seen, ["after"]);
  });
});
