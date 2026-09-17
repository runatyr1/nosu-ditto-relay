import { strict as assert } from "node:assert";
import process from "node:process";
import { describe, it } from "node:test";

import {
  memorySampleFailures,
  mergeExposition,
  startRuntimeMetrics,
} from "./metrics.ts";

describe("mergeExposition", () => {
  it("groups samples from multiple threads under one HELP/TYPE header", () => {
    const main = [
      "# HELP ditto_relay_messages_total Total Nostr messages processed by relay",
      "# TYPE ditto_relay_messages_total counter",
      'ditto_relay_messages_total{verb="REQ"} 5',
      "",
      "# HELP ditto_relay_connections Active relay connections",
      "# TYPE ditto_relay_connections gauge",
      "ditto_relay_connections 2",
      "",
    ].join("\n");
    const worker = [
      "# HELP ditto_relay_messages_total Total Nostr messages processed by relay",
      "# TYPE ditto_relay_messages_total counter",
      'ditto_relay_messages_total{verb="REQ"} 7',
      'ditto_relay_messages_total{verb="EVENT"} 3',
      "",
    ].join("\n");

    const merged = mergeExposition([
      { label: "main", text: main },
      { label: "0", text: worker },
    ]);

    const lines = merged.split("\n");
    // Exactly one HELP/TYPE pair per metric.
    assert.equal(
      lines.filter((l) => l.startsWith("# HELP ditto_relay_messages_total"))
        .length,
      1,
    );
    assert.equal(
      lines.filter((l) => l.startsWith("# TYPE ditto_relay_messages_total"))
        .length,
      1,
    );
    // Samples carry the worker label, merged into existing label sets.
    assert.ok(
      merged.includes('ditto_relay_messages_total{worker="main",verb="REQ"} 5'),
    );
    assert.ok(
      merged.includes('ditto_relay_messages_total{worker="0",verb="REQ"} 7'),
    );
    assert.ok(
      merged.includes('ditto_relay_messages_total{worker="0",verb="EVENT"} 3'),
    );
    // Label-less samples get a fresh label set.
    assert.ok(merged.includes('ditto_relay_connections{worker="main"} 2'));

    // All samples of a metric are contiguous (required by Prometheus).
    const sampleMetric = (l: string) =>
      !l.startsWith("#") && l.length > 0
        ? l.slice(0, l.search(/[{ ]/))
        : undefined;
    const order = lines.map(sampleMetric).filter((n) => n !== undefined);
    const firstConn = order.indexOf("ditto_relay_connections");
    const lastMessages = order.lastIndexOf("ditto_relay_messages_total");
    assert.ok(
      lastMessages < firstConn,
      "messages_total samples must be contiguous before connections",
    );
  });

  it("handles histogram blocks", () => {
    const text = [
      "# HELP ditto_relay_req_duration_seconds Duration of REQ handling",
      "# TYPE ditto_relay_req_duration_seconds histogram",
      'ditto_relay_req_duration_seconds_bucket{le="0.005"} 1',
      'ditto_relay_req_duration_seconds_bucket{le="+Inf"} 2',
      "ditto_relay_req_duration_seconds_sum 0.5",
      "ditto_relay_req_duration_seconds_count 2",
      "",
    ].join("\n");

    const merged = mergeExposition([{ label: "1", text }]);
    assert.ok(
      merged.includes(
        'ditto_relay_req_duration_seconds_bucket{worker="1",le="0.005"} 1',
      ),
    );
    assert.ok(
      merged.includes('ditto_relay_req_duration_seconds_sum{worker="1"} 0.5'),
    );
  });
});

describe("startRuntimeMetrics", () => {
  it("survives process.memoryUsage() throwing", async () => {
    // Regression: the throw used to escape the timer callback as an
    // uncaught exception and kill the relay. Bun raises SystemError
    // "Failed to get memory usage" on the production LXC host.
    /** Read the counter's unlabelled value out of its exposition text. */
    const failures = (): number => {
      const line = memorySampleFailures
        .serialize()
        .split("\n")
        .find((l) => l.startsWith("ditto_memory_sample_failures_total "));
      return line ? Number(line.split(" ")[1]) : 0;
    };

    const original = process.memoryUsage;
    const before = failures();
    let calls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (process as any).memoryUsage = () => {
      calls++;
      throw new Error("Failed to get memory usage");
    };

    let stop: (() => void) | undefined;
    try {
      stop = startRuntimeMetrics(5, { memory: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      stop?.();
      process.memoryUsage = original;
    }

    assert.ok(calls > 0, "stub was never called");
    assert.ok(failures() > before, "failure counter did not advance");
  });

  it("stops both timers when the returned disposer runs", () => {
    const stop = startRuntimeMetrics(5, { memory: true });
    assert.doesNotThrow(() => stop());
  });
});
