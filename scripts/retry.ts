/**
 * Retry helper shared by the long-running maintenance scripts.
 *
 * These scripts walk the whole index in thousands of batches over hours, so
 * a single failed request must not end the run. Two kinds of failure are
 * worth retrying, and both are transient:
 *
 * - The cluster pushing back — circuit breakers, 429s, a search phase that
 *   blew its memory budget. Retrying after a pause, having cleared the
 *   fielddata cache, is exactly the right response.
 * - Something transient underneath a long request: the connection breaking,
 *   which Bun surfaces as `Malformed_HTTP_Response` and friends, or the
 *   index being closed for the moment a `migrate()` takes to update
 *   settings. An `updateByQuery` over a 300M-document index runs long
 *   enough to meet both. Treating either as fatal loses hours of completed
 *   work for a fault a second attempt almost always clears.
 *
 * Retrying assumes the operation is idempotent. The callers qualify: each
 * one computes a value and assigns it (`ctx._source.followers = count`),
 * so running it twice lands on the same state as running it once.
 */

/** Delay for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cluster-side backpressure: the request was refused, not lost. */
const OVERLOAD_SIGNS = [
  "circuit_breaking",
  "429",
  "Data too large",
  "search_phase_execution_exception",
  "too_many_requests",
];

/**
 * Conditions that clear themselves in seconds: a broken connection, or an
 * index that is momentarily closed.
 *
 * `index_closed_exception` belongs here because `migrate()` close/opens the
 * index to apply analyzer settings, and the relay runs `migrate()` every
 * time it starts. A relay restart mid-backfill therefore lands a closed
 * index under a script that has hours of work behind it.
 */
const TRANSIENT_SIGNS = [
  "index_closed_exception",
  "Malformed_HTTP_Response",
  "ConnectionClosed",
  "ConnectionRefused",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "socket connection was closed",
  "fetch failed",
  "The socket connection was closed unexpectedly",
];

/** How a failure should be retried, or `null` if it should not be. */
export type RetryKind = "overload" | "transient";

/**
 * Classify a failure.
 *
 * The distinction drives how long to wait. Overload means the cluster needs
 * time to recover, so backing off tens of seconds is the point. A transient
 * fault means one connection broke or the index was closed for a moment;
 * the cluster is fine and waiting accomplishes little, so a brief pause and
 * another attempt is right. Treating both the same way made a run spend
 * most of its wall clock asleep.
 */
export function classifyError(error: unknown): RetryKind | null {
  const msg = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const matches = (sign: string) => msg.includes(sign) || code.includes(sign);

  if (OVERLOAD_SIGNS.some(matches)) return "overload";
  if (TRANSIENT_SIGNS.some(matches)) return "transient";
  return null;
}

/** Whether `error` is worth another attempt. */
export function isRetryable(error: unknown): boolean {
  return classifyError(error) !== null;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 *
 * `onRetry` runs before each retry — callers use it to clear the fielddata
 * cache, which is what usually frees the circuit breaker.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    baseDelay?: number;
    /** Base delay for transient faults. Defaults to 1s. */
    transientDelay?: number;
    onRetry?: () => Promise<void>;
  } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelay = opts.baseDelay ?? 30_000;
  const transientDelay = opts.transientDelay ?? 1_000;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const kind = classifyError(error);
      if (kind === null || attempt >= maxRetries) throw error;

      const base = kind === "transient" ? transientDelay : baseDelay;
      const delay = base * 2 ** attempt;
      const reason = error instanceof Error ? error.message : String(error);
      console.log(
        `Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries}): ${reason.slice(0, 200)}`,
      );
      // Clearing the fielddata cache is what frees a circuit breaker; it
      // does nothing for a broken connection and costs the cluster work.
      if (opts.onRetry && kind === "overload") {
        try {
          await opts.onRetry();
        } catch (_) {
          // Ignore
        }
      }
      await sleep(delay);
    }
  }
}
