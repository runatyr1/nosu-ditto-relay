/**
 * Early inbound-message buffer for worker entry modules.
 *
 * A worker's inbound messages are NOT held until it installs a handler. As
 * of Bun 1.4, messages that arrive while the worker module is still
 * evaluating are dispatched to the global scope and dropped on the floor if
 * no `onmessage` handler exists yet — matching browser semantics, where the
 * implicit port starts before a module with a top-level `await` finishes
 * evaluating. (Bun 1.3 queued them until evaluation completed, which is what
 * the pool used to rely on.)
 *
 * That window is real: the pool posts the indexer port to a protocol worker
 * the instant it spawns it, and after a crash it posts `open`/`msgs` for new
 * connections to the respawned slot immediately. A dropped message there
 * means a permanently unbound indexer client (every write hangs) or a
 * connection the worker never learns about (every frame is lost).
 *
 * Importing this module installs a global handler that buffers everything
 * from the first tick of the worker's evaluation. The entry then calls
 * {@link onWorkerMessage} once its real handler is ready, and the buffered
 * messages replay in arrival order.
 *
 * Import it from worker entry modules only — it takes over `self.onmessage`.
 * It must also be the only import in the graph that can suspend evaluation
 * before it runs: keep it free of top-level `await`, directly and
 * transitively, or the window it exists to close reopens.
 */

declare var self: Worker;

/** Messages received before the entry registered its handler. */
let buffered: MessageEvent[] = [];
let handler: ((event: MessageEvent) => void) | undefined;

self.onmessage = (event: MessageEvent) => {
  if (handler) {
    handler(event);
  } else {
    buffered.push(event);
  }
};

/**
 * Register the worker's real message handler and replay anything that
 * arrived during initialization, in order.
 */
export function onWorkerMessage<T>(fn: (event: MessageEvent<T>) => void): void {
  handler = fn as (event: MessageEvent) => void;
  const pending = buffered;
  buffered = [];
  for (const event of pending) {
    fn(event as MessageEvent<T>);
  }
}
