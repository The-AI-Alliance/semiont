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

import { BehaviorSubject, Subject, type Observable } from 'rxjs';
import type { SemiontError } from './errors';
import type { BaseUrl } from './branded-types';
import { baseUrl as makeBaseUrl } from './branded-types';
import type { ResourceId } from './identifiers';
import type { EventMap } from './bus-protocol';
import type { ConnectionState, ITransport } from './transport';
import { EventBus } from './event-bus';
import { BRIDGED_CHANNELS } from './bridged-channels';
import { BUS_OPERATIONS, type BusOperationKey } from './bus-operations';

/** One wire behavior, applied to a single request-channel emit. */
export type FaultAction =
  | { kind: 'deliver' }
  | { kind: 'drop-reply' }
  | { kind: 'delay'; ms: number }
  | { kind: 'duplicate-reply' }
  | { kind: 'reject-emit' };

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

function isOperation(channel: string): channel is BusOperationKey {
  return channel in BUS_OPERATIONS;
}

/** Stable request identity: channel + sorted payload minus per-issue fields. */
export function retryKeyOf(channel: string, payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
    .filter(([k]) => k !== 'correlationId' && k !== '_trace' && k !== '_userId')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `${channel} ${JSON.stringify(entries)}`;
}

export class FaultyTransport implements ITransport {
  readonly baseUrl: BaseUrl = makeBaseUrl('faulty://simulator');
  readonly state$ = new BehaviorSubject<ConnectionState>('open');
  private readonly errorsSubject = new Subject<SemiontError>();
  readonly errors$: Observable<SemiontError> = this.errorsSubject.asObservable();

  /** Every request-channel emit, in order — the L2 accounting surface. */
  readonly requestLog: RequestLogEntry[] = [];

  private readonly bus = new EventBus();
  private readonly schedule: readonly FaultAction[];
  private readonly makeResponse: (op: BusOperationKey, payload: Record<string, unknown>) => unknown;
  private readonly replyQueues = new Map<BusOperationKey, unknown[]>();
  private requestCount = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(cfg: FaultyTransportConfig = {}) {
    this.schedule = cfg.schedule ?? [];
    this.makeResponse = cfg.makeResponse ?? (() => ({}));
  }

  /**
   * Queue responses for `op`, consumed FIFO — one per request that reaches
   * the simulated backend — before falling back to `makeResponse`
   * (SDK-TESTING-DOUBLE.md, gap 2). The queue scripts the BACKEND; the fault
   * schedule scripts the WIRE. Consequences, deliberately: `duplicate-reply`
   * replays one entry's body twice, and a `drop-reply` still consumes its
   * entry (the backend answered; the wire ate it) — so "first reply lost,
   * the retry sees the NEXT page" is expressible. `reject-emit` consumes
   * nothing: that request never reached the backend.
   */
  queueReply(op: BusOperationKey, ...responses: unknown[]): void {
    const q = this.replyQueues.get(op) ?? [];
    q.push(...responses);
    this.replyQueues.set(op, q);
  }

  // ── Bus primitives ──────────────────────────────────────────────────────

  async emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    resourceScope?: ResourceId,
  ): Promise<number> {
    // The double models exactly one connected participant, so a delivered
    // emit reports `1`; post-dispose it is inert and reports the `-1`
    // "count unknown" sentinel.
    if (this.disposed) return -1;
    const name = channel as string;
    if (!isOperation(name)) {
      // Non-request channel: forward as-is (scoped or global).
      const target = resourceScope === undefined
        ? this.bus.get(channel)
        : this.bus.scope(resourceScope as string).get(channel);
      target.next(payload);
      return 1;
    }

    const record = payload as Record<string, unknown>;
    const action: FaultAction = this.schedule.length === 0
      ? { kind: 'deliver' }
      : this.schedule[this.requestCount % this.schedule.length]!;
    this.requestCount += 1;
    this.requestLog.push({
      channel: name,
      action,
      correlationId: typeof record.correlationId === 'string' ? record.correlationId : undefined,
      retryKey: retryKeyOf(name, record),
      payload: { ...record },
    });

    if (action.kind === 'reject-emit') {
      // Models a /bus/emit 4xx: the request never reaches the bus.
      throw new Error(`FaultyTransport: emit rejected by schedule (reject-emit) on ${name}`);
    }

    // The request itself is observable (handlers-eye view), then the
    // simulator plays backend: synthesize the registry reply per the action.
    this.bus.get(channel).next(payload);

    // The backend's answer is computed ONCE per request that reaches it —
    // the reply QUEUE scripts the backend, the fault schedule scripts the
    // wire (SDK-TESTING-DOUBLE.md Phase 2). So `duplicate-reply` replays the
    // same body twice, and a `drop-reply` still consumes its queue entry:
    // the backend answered, the wire ate it.
    const queue = this.replyQueues.get(name);
    const response = queue && queue.length > 0 ? queue.shift() : this.makeResponse(name, record);

    const reply = (): void => {
      if (this.disposed) return;
      const replyPayload = response === undefined
        ? { correlationId: record.correlationId }
        : { correlationId: record.correlationId, response };
      const resultChannel = BUS_OPERATIONS[name].result as keyof EventMap;
      this.bus.get(resultChannel).next(replyPayload as EventMap[keyof EventMap]);
    };

    switch (action.kind) {
      case 'deliver':
        queueMicrotask(reply);
        break;
      case 'duplicate-reply':
        queueMicrotask(reply);
        queueMicrotask(reply);
        break;
      case 'delay': {
        const t = setTimeout(() => { this.timers.delete(t); reply(); }, action.ms);
        this.timers.add(t);
        break;
      }
      case 'drop-reply':
        break;
    }
    return 1;
  }

  on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K]) => void): () => void {
    const sub = this.bus.get(channel).subscribe(handler);
    return () => sub.unsubscribe();
  }

  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.bus.get(channel);
  }

  subscribeToResource(_rid: ResourceId): () => void {
    // Mirrors the real HttpTransport: distinct scopes COMPOSE
    // (MULTI-RESOURCE-SCOPE). Delivery here is bus-direct and never
    // scope-gated, so acquisition needs no bookkeeping and release
    // (idempotent by construction) is a no-op.
    return () => {};
  }

  /**
   * Correlated-reply tracking (BUS-RESUMPTION.md Phase 2 / SDK-DEBT S1),
   * exposed for assertions: `busRequest` registers each cid here before its
   * emit and releases on settle, so a test can pin the tracked set at any
   * point of a request's lifecycle. Delivery in this double is bus-direct
   * (nothing to replay), so tracking has no behavioral effect.
   */
  readonly pendingReplies = new Set<string>();

  trackReply(correlationId: string): () => void {
    this.pendingReplies.add(correlationId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingReplies.delete(correlationId);
    };
  }

  bridgeInto(bus: EventBus): void {
    for (const channel of BRIDGED_CHANNELS) {
      this.bus.get(channel as keyof EventMap).subscribe((payload) => {
        bus.get(channel as keyof EventMap).next(payload as EventMap[keyof EventMap]);
      });
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.state$.next('closed');
    this.state$.complete();
    this.errorsSubject.complete();
    // Completes every subject: in-flight busRequests resolve `bus.closed`.
    this.bus.destroy();
  }
}
