/**
 * The signal plane's own policy: what the spec does not state. What it does
 * state — how long a claim lasts, how long a reply is retained, how many
 * replies a client may await, how many scopes a connection may hold — is read
 * from it (`operationLimits` and `itemLimits` in `@semiont/core/openapi`),
 * never restated here.
 */

/** Scopes on one connection past which the gateway logs the matrix as large. */
export const SCOPE_WARN_THRESHOLD = 128;

/**
 * Claims one gateway's projection holds at once. Claims are cheap (two
 * strings and a timestamp) and long-lived; past this the oldest is evicted.
 */
export const CLAIM_MAX_GLOBAL = 4096;

/**
 * Bound on a `flush()` round trip (boot gate and shutdown drain).
 *
 * It is one PING/PONG to a reachable broker — milliseconds. This is not a
 * latency budget but a liveness bound: the client reconnects forever, so
 * against a dead broker an unbounded flush never settles, and the two callers
 * are boot (before the port opens) and shutdown (before teardown finishes).
 */
export const SIGNAL_FLUSH_TIMEOUT_MS = 10_000;
