/**
 * Bus logging — runtime-toggleable cross-wire visibility.
 *
 * One line per event that crosses a process boundary, in a grep-able
 * format that's symmetric across frontend and gateway:
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
export type BusOp = 'EMIT' | 'RECV' | 'SSE' | 'PUT' | 'GET';
export declare function busLogEnabled(): boolean;
export declare function setBusLogTraceIdProvider(fn: (() => string | undefined) | undefined): void;
export declare function busLog(op: BusOp, channel: string, payload: unknown, scope?: string): void;
/**
 * Whether to run the unobserved-reply check on every local emit.
 *
 * On in Node (gateway + worker + smelter), where a dropped reply is a real
 * delivery bug; off in the browser, where a 0-observer bridged reply just
 * means the awaiting `busRequest` already resolved/timed out (benign).
 *
 * Always-on (no env flag) by design: the failure it catches is rare and
 * high-signal, and the whole point is that it fires with zero setup — the
 * incident that motivated it (.plans/bugs/gather-resource-complete-not-bridged.md)
 * ran with bus-logging off, so a flag-gated check would have stayed silent.
 */
export declare function warnUnobservedRepliesEnabled(): boolean;
/**
 * The silent-dropped-reply detector.
 *
 * A correlation-bearing payload is a request/reply *reply* (`*-result`,
 * `*-complete`, `*-failed`, …). If one is emitted on the gateway bus with
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
export declare function warnIfUnobservedReply(channel: string, payload: unknown, observerCount: number): void;
