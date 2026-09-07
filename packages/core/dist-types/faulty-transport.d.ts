/**
 * FaultyTransport — a seeded, scriptable `ITransport` simulator for the
 * liveness axioms (`.plans/LIVENESS-AXIOMS.md`). fast-check draws a fault
 * schedule; the transport applies one `FaultAction` per request-channel emit
 * and synthesizes replies from the `BUS_OPERATIONS` registry, so real
 * compositions (`busRequest`, SWR caches, live queries) run unmodified against
 * generated wire behavior no hand-written test names.
 *
 * Home is core (not sdk/test-utils) for the same reason as
 * `assertStateUnitAxioms`: it needs only core types, and every layer —
 * including `http-transport`, below sdk — can consume it via
 * `@semiont/core/testing` without a dependency cycle.
 *
 * Deterministic-by-construction: no `Date.now`, no randomness of its own —
 * all variation comes in through the schedule (fast-check owns the seed).
 * Time is real `setTimeout` at millisecond scale; properties pass a small
 * explicit `timeoutMs` to `busRequest`, so nothing waits 30 s.
 */
import { BehaviorSubject, type Observable } from 'rxjs';
import type { SemiontError } from './errors';
import type { BaseUrl } from './branded-types';
import type { ResourceId } from './identifiers';
import type { EventMap } from './bus-protocol';
import type { ConnectionState, ITransport } from './transport';
import { EventBus } from './event-bus';
import { type BusOperationKey } from './bus-operations';
/** One wire behavior, applied to a single request-channel emit. */
export type FaultAction = {
    kind: 'deliver';
} | {
    kind: 'drop-reply';
} | {
    kind: 'delay';
    ms: number;
} | {
    kind: 'duplicate-reply';
} | {
    kind: 'reject-emit';
};
/** requestLog entry — one per request-channel emit, in arrival order. */
export interface RequestLogEntry {
    channel: BusOperationKey;
    /** The action the schedule assigned to this emit. */
    action: FaultAction;
    correlationId: string | undefined;
    /**
     * Request identity for retry accounting: channel + payload minus the
     * per-issue fields (`correlationId`, `_trace`, `_userId`). Two emits with
     * the same key are the same logical request re-issued.
     */
    retryKey: string;
    /**
     * The payload as emitted — envelope, options, params, `correlationId` and
     * all. This is the surface for "assert what my orchestrator actually SENT"
     * (SDK-TESTING-DOUBLE gap 6): without it every consumer harness re-invented
     * a per-channel `transport.on(...)` wire recorder alongside this log.
     *
     * SHALLOW snapshot: the top level is copied at emit time, so a caller that
     * mutates its own payload object afterwards cannot rewrite history. Nested
     * objects are shared by reference — deep-freeze is not worth the cost in a
     * double, and no in-repo caller mutates nested request payloads.
     */
    payload: Record<string, unknown>;
}
export interface FaultyTransportConfig {
    /**
     * The i-th request-channel emit applies `schedule[i % schedule.length]`.
     * Empty/omitted → every request delivers.
     */
    schedule?: readonly FaultAction[];
    /**
     * Synthesize the `response` value for a delivered reply. Return `undefined`
     * for a void ack (`{ correlationId }` only). Default: `{}` for every op.
     */
    makeResponse?: (operation: BusOperationKey, payload: Record<string, unknown>) => unknown;
}
/** Stable request identity: channel + sorted payload minus per-issue fields. */
export declare function retryKeyOf(channel: string, payload: Record<string, unknown>): string;
export declare class FaultyTransport implements ITransport {
    readonly baseUrl: BaseUrl;
    readonly state$: BehaviorSubject<ConnectionState>;
    private readonly errorsSubject;
    readonly errors$: Observable<SemiontError>;
    /** Every request-channel emit, in order — the L2 accounting surface. */
    readonly requestLog: RequestLogEntry[];
    private readonly bus;
    private readonly schedule;
    private readonly makeResponse;
    private readonly replyQueues;
    private requestCount;
    private readonly timers;
    private disposed;
    constructor(cfg?: FaultyTransportConfig);
    /**
     * Queue responses for `op`, consumed FIFO — one per request that reaches
     * the simulated gateway — before falling back to `makeResponse`
     * (SDK-TESTING-DOUBLE.md, gap 2). The queue scripts the GATEWAY; the fault
     * schedule scripts the WIRE. Consequences, deliberately: `duplicate-reply`
     * replays one entry's body twice, and a `drop-reply` still consumes its
     * entry (the gateway answered; the wire ate it) — so "first reply lost,
     * the retry sees the NEXT page" is expressible. `reject-emit` consumes
     * nothing: that request never reached the gateway.
     */
    queueReply(op: BusOperationKey, ...responses: unknown[]): void;
    emit<K extends keyof EventMap>(channel: K, payload: EventMap[K], resourceScope?: ResourceId): Promise<number>;
    on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K]) => void): () => void;
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]>;
    subscribeToResource(_rid: ResourceId): () => void;
    /**
     * Correlated-reply tracking (BUS-RESUMPTION.md Phase 2 / SDK-DEBT S1),
     * exposed for assertions: `busRequest` registers each cid here before its
     * emit and releases on settle, so a test can pin the tracked set at any
     * point of a request's lifecycle. Delivery in this double is bus-direct
     * (nothing to replay), so tracking has no behavioral effect.
     */
    readonly pendingReplies: Set<string>;
    trackReply(correlationId: string): () => void;
    bridgeInto(bus: EventBus): void;
    dispose(): void;
}
