import { BUS_REQUEST_TIMEOUT_MS } from '@semiont/core';

/**
 * The Signal Plane's tunables (SIGNAL-PLANE D8, P0.1 q4 — RATIFIED: seven).
 *
 * Every value here governs plane behavior and was compiled into `bus.ts`
 * until 2026-09-15, tunable only by release — each taught by an incident
 * (the caps by the 2026-09-03 OOM; the retention split by BUS-RESUMPTION).
 * They are construction options now, with these values as the defaults, so
 * P0 is behavior-identical while ending the tune-by-release era. P2 surfaces
 * them as optional `[signal]` keys with the same refusal discipline as D6.
 *
 * NOT here, deliberately: `MAX_PENDING_WRITE_BYTES` and
 * `MAX_REPLAY_BUFFER_EVENTS` stay in `bus.ts` — they bound the SSE edge and
 * the replay window, code that stays in the gateway with or without a broker
 * behind it (§What this plan fixes). The plan's "seven" is the plane's seven:
 * the subscription matrix pair and the ledger's five.
 */

/**
 * Per-connection scope cap (MULTI-RESOURCE-SCOPE, open question 6). The
 * named consumer's normal working set is 40–60 scopes (one per chat
 * message), so the cap is a runaway guard, not a budget — provisional
 * pending the subscription-explosion benchmark (plan risk 5).
 */
export const MAX_SCOPES = 512;
export const SCOPE_WARN_THRESHOLD = 128;

/** Retained reply payloads: older than the caller's 30 s deadline is useless — 2× headroom. */
export const REPLY_RETENTION_TTL_MS = 60_000;
export const REPLY_RETENTION_MAX = 1024;
/** Per-client claim capacity, and the cap on a subscribe body's `pendingReplies`. */
export const PENDING_REPLIES_MAX = 256;
/**
 * Claims are cheap (two strings and a timestamp) and long-lived; reply
 * payloads are expensive and short-lived. Deliberately different budgets.
 */
export const CLAIM_TTL_MS = 15 * 60_000;
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

/** The seven, as one construction-options shape. */
export interface SignalPlaneOptions {
  maxScopes?: number;
  scopeWarnThreshold?: number;
  replyRetentionTtlMs?: number;
  replyRetentionMax?: number;
  pendingRepliesMax?: number;
  claimTtlMs?: number;
  claimMaxGlobal?: number;
}

export interface ResolvedSignalPlaneOptions {
  maxScopes: number;
  scopeWarnThreshold: number;
  replyRetentionTtlMs: number;
  replyRetentionMax: number;
  pendingRepliesMax: number;
  claimTtlMs: number;
  claimMaxGlobal: number;
}

/**
 * The ratified q4 rider: `replyRetentionTtlMs`'s tie to the caller's
 * deadline is a PROTOCOL RELATIONSHIP (retention ≥ 2× the busRequest
 * deadline), not a free knob — asserted at construction, so a config that
 * breaks the relationship refuses instead of silently stranding reconnect
 * recovery inside the window callers still retry in. The deadline itself is
 * core's fact (`BUS_REQUEST_TIMEOUT_MS`, busRequest's default) — derived
 * here, never restated.
 */

export function resolveSignalPlaneOptions(opts: SignalPlaneOptions = {}): ResolvedSignalPlaneOptions {
  const resolved: ResolvedSignalPlaneOptions = {
    maxScopes: opts.maxScopes ?? MAX_SCOPES,
    scopeWarnThreshold: opts.scopeWarnThreshold ?? SCOPE_WARN_THRESHOLD,
    replyRetentionTtlMs: opts.replyRetentionTtlMs ?? REPLY_RETENTION_TTL_MS,
    replyRetentionMax: opts.replyRetentionMax ?? REPLY_RETENTION_MAX,
    pendingRepliesMax: opts.pendingRepliesMax ?? PENDING_REPLIES_MAX,
    claimTtlMs: opts.claimTtlMs ?? CLAIM_TTL_MS,
    claimMaxGlobal: opts.claimMaxGlobal ?? CLAIM_MAX_GLOBAL,
  };
  if (resolved.replyRetentionTtlMs < 2 * BUS_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `signal plane: replyRetentionTtlMs ${resolved.replyRetentionTtlMs} violates the protocol ` +
        `relationship retention ≥ 2× the ${BUS_REQUEST_TIMEOUT_MS} ms busRequest deadline`,
    );
  }
  return resolved;
}
