/**
 * Bus logging — runtime-toggleable cross-wire visibility.
 *
 * One line per event that crosses a process boundary, in a grep-able
 * format that's symmetric across frontend and backend:
 *
 *   [bus EMIT] <channel> [scope=X] [cid=<first8>] <payload>
 *   [bus RECV] <channel> [scope=X] [cid=<first8>] <payload>
 *   [bus SSE]  <channel> [scope=X] [cid=<first8>] <payload>
 *
 * Tier 1 of `.plans/OBSERVABILITY.md`. Forward-compatible with Tier 2:
 * the `cid` printed here is exactly the prefix of the W3C trace-id we
 * adopt later.
 *
 * Cost when disabled: one property read per call, zero allocations.
 *
 * Enable:
 *   - Browser:  `window.__SEMIONT_BUS_LOG__ = true` (DevTools or e2e init)
 *   - Node:     `SEMIONT_BUS_LOG=1` in the process env (read at module load)
 */

import { BRIDGED_CHANNELS } from './bridged-channels';

const NODE_BUS_LOG =
  typeof process !== 'undefined' && !!process.env?.SEMIONT_BUS_LOG;

const IS_NODE =
  typeof process !== 'undefined' && !!process.versions?.node;

export type BusOp = 'EMIT' | 'RECV' | 'SSE' | 'PUT' | 'GET';

export function busLogEnabled(): boolean {
  const g = globalThis as { __SEMIONT_BUS_LOG__?: boolean };
  if (g.__SEMIONT_BUS_LOG__) return true;
  return NODE_BUS_LOG;
}

/**
 * Optional active-span trace-id provider. When a Tier 2 OTel SDK is
 * initialized, `@semiont/observability` registers a provider here that
 * returns the active span's W3C `trace_id`. busLog appends it to each
 * emitted line so the grep-timeline correlates with the span tree in
 * an APM UI.
 *
 * Decoupling: `@semiont/core` does not depend on `@opentelemetry/api`.
 * If no provider is registered (Tier 1-only deployments, or before
 * `initObservabilityNode` runs), the field is omitted from the line —
 * same shape as before this hook existed.
 */
let traceIdProvider: (() => string | undefined) | undefined;

export function setBusLogTraceIdProvider(fn: (() => string | undefined) | undefined): void {
  traceIdProvider = fn;
}

export function busLog(
  op: BusOp,
  channel: string,
  payload: unknown,
  scope?: string,
): void {
  if (!busLogEnabled()) return;
  const cidRaw = (payload as { correlationId?: unknown } | null | undefined)?.correlationId;
  const cid = typeof cidRaw === 'string' ? cidRaw.slice(0, 8) : undefined;
  let traceId: string | undefined;
  if (traceIdProvider) {
    try { traceId = traceIdProvider(); } catch { /* noop */ }
  }
  const tag =
    `[bus ${op}] ${channel}` +
    (scope ? ` scope=${scope}` : '') +
    (cid ? ` cid=${cid}` : '') +
    (traceId ? ` trace=${traceId.slice(0, 8)}` : '');
  // eslint-disable-next-line no-console
  console.debug(tag, payload);
}

/**
 * Whether to run the unobserved-reply check on every local emit.
 *
 * On in Node (backend + worker + smelter), where a dropped reply is a real
 * delivery bug; off in the browser, where a 0-observer bridged reply just
 * means the awaiting `busRequest` already resolved/timed out (benign).
 *
 * Always-on (no env flag) by design: the failure it catches is rare and
 * high-signal, and the whole point is that it fires with zero setup — the
 * incident that motivated it (.plans/bugs/gather-resource-complete-not-bridged.md)
 * ran with bus-logging off, so a flag-gated check would have stayed silent.
 */
export function warnUnobservedRepliesEnabled(): boolean {
  return IS_NODE;
}

/** One line per channel per process — a missing fan-in wiring is a config
 *  bug, so the first dropped reply is enough; we don't spam on retries. */
const unobservedReplyWarned = new Set<string>();

/**
 * The silent-dropped-reply detector.
 *
 * A correlation-bearing payload is a request/reply *reply* (`*-result`,
 * `*-complete`, `*-failed`, …). If one is emitted on the backend bus with
 * **zero local observers**, nothing forwards it — no SSE subscription, no
 * in-process consumer — so the awaiting client never receives it and times
 * out 30 s later with no error logged anywhere. That is exactly how
 * `gather:resource-complete` failed when it was missing from
 * `BRIDGED_CHANNELS` (.plans/bugs/gather-resource-complete-not-bridged.md).
 *
 * Emits one WARN per channel naming the likely fix. Ignored (no warning):
 * non-reply emits (no `correlationId`), emits with observers, and — crucially —
 * channels already in `BRIDGED_CHANNELS`: a 0-observer emit there is a redundant
 * copy, not a gap (see .plans/bugs/BRIDGE-GAPS.md). So the detector fires only
 * for a genuine missing forwarder, and its remediation text is always correct.
 */
export function warnIfUnobservedReply(
  channel: string,
  payload: unknown,
  observerCount: number,
): void {
  if (observerCount > 0) return;
  const cidRaw = (payload as { correlationId?: unknown } | null | undefined)?.correlationId;
  if (typeof cidRaw !== 'string' || cidRaw.length === 0) return;
  // A 0-observer emit on a *bridged* channel is a redundant copy (a global +
  // resource-scoped dual-emit, or an SSE reconnect replay), not a missing
  // forwarder — the first copy already reached the awaiting `take(1)`
  // subscriber. Only a NOT-bridged channel is a genuine drop. (`busRequest` now
  // types its reply channels `BridgedChannel`, so an unbridged reply is a
  // compile error; this runtime check covers non-`busRequest` correlation
  // emits.) See .plans/bugs/BRIDGE-GAPS.md.
  if ((BRIDGED_CHANNELS as readonly string[]).includes(channel)) return;
  if (unobservedReplyWarned.has(channel)) return;
  unobservedReplyWarned.add(channel);
  // eslint-disable-next-line no-console
  console.warn(
    `[bus DROP] ${channel} cid=${cidRaw.slice(0, 8)} emitted with 0 subscribers and not in ` +
      `BRIDGED_CHANNELS — a correlation reply with no forwarder is dropped, so the awaiting ` +
      `client times out (no error). Add '${channel}' to BRIDGED_CHANNELS ` +
      `(packages/core/src/bridged-channels.ts) so transports subscribe to it.`,
  );
}
