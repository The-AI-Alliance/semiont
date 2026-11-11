/**
 * FaultyTransport — a seeded, scriptable `ITransport` simulator for the
 * liveness axioms. fast-check draws a fault
 * schedule; the transport applies one `FaultAction` per request-channel emit
 * and synthesizes replies from the `BUS_OPERATIONS` registry, so real
 * compositions (`Bus.request`, SWR caches, live queries) run unmodified against
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
 * explicit `timeoutMs` to `Bus.request`, so nothing waits 30 s.
 */

import { BehaviorSubject, Subject, type Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import type { SemiontError } from './errors';
import type { BaseUrl } from './branded-types';
import { baseUrl as makeBaseUrl } from './branded-types';
import type { ResourceId } from './identifiers';
import { TRACE_FIELD, type EventMap } from './bus-protocol';
import type { BusEnvelope, BusFrame } from './event-bus';
import type { ConnectionState, ITransport } from './transport';
import { EventBus } from './event-bus';
import { BUS_OPERATIONS, REPLY_NAMES, type BusOperationKey } from './bus-operations';
import { asDeclared, type FrameRefusal } from './bus';
import { BusRequestError } from './bus-request';
import { isResourceScopedChannel, RESOURCE_SCOPED_CHANNELS } from './bridged-channels';
import { relayFrames } from './relay-frames';

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
   * per-issue fields (`TRACE_FIELD`, `_userId`). Two emits with the same key are
   * the same logical request re-issued.
   */
  retryKey: string;
  /**
   * The payload as emitted — options, params and all. The envelope is not
   * part of it: its key is this entry's `correlationId`. This is the surface
   * for "assert what my orchestrator actually SENT": without it every
   * consumer harness needs its own per-channel `transport.on(...)` wire
   * recorder alongside this log.
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
   * The global channels this transport is given, as a wire transport is
   * given its stream's: a frame of no scope reaches a reader only on one of
   * them, a request's echo and a reply included; it bridges them, beside the
   * resource-scoped channels, into a client's bus, answers `isSubscribed` for
   * them alone, and assumes none of its own. A full client's test gives it `BRIDGED_CHANNELS`; a worker's,
   * the reply channels it awaits and what its claims read
   * (`JOB_CLAIM_CHANNELS`).
   */
  channels: readonly (keyof EventMap)[];
  /**
   * The i-th request-channel emit applies `schedule[i % schedule.length]`.
   * Empty/omitted → every request delivers.
   */
  schedule?: readonly FaultAction[];
  /**
   * Synthesize the `response` value for a delivered reply. Return `undefined`
   * for a void ack (a reply that carries no `response`). Default:
   * `refuseUnscriptedOperation`, which throws naming the operation.
   */
  makeResponse?: (operation: BusOperationKey, payload: Record<string, unknown>) => unknown;
}

/**
 * The default `makeResponse`: refuse, rather than invent.
 *
 * A `() => ({})` default would answer every unscripted operation with a
 * SUCCESS whose every field is `undefined`. That is not a neutral default —
 * it is a fabricated reply, and it surfaces far from its cause (a caller doing
 * `result.engines.find(...)` reports `undefined is not a function`, naming
 * neither the operation nor the missing script). A shape-correct empty default
 * would be worse still: a hand-written mirror of a wire shape the spec owns,
 * carrying a fallback.
 *
 * So the default names the gap. A test that wants an answer scripts one via
 * `queueReply` or its own `makeResponse`.
 */
export function refuseUnscriptedOperation(operation: string): never {
  throw new Error(
    `No response scripted for bus operation "${operation}". ` +
      `Script one with transport.queueReply('${operation}', <response>) ` +
      `or pass a makeResponse that handles it.`,
  );
}

function isOperation(channel: string): channel is BusOperationKey {
  return channel in BUS_OPERATIONS;
}

/** Stable request identity: channel + sorted payload minus per-issue fields.
 *  The correlation key is not among them — it rides the envelope, so the
 *  payload is stable across retries of the same request. */
export function retryKeyOf(channel: string, payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
    .filter(([k]) => k !== TRACE_FIELD && k !== '_userId')
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

  /** Every frame emitted, a request's echo and its reply included: what a reader is given is gated in `frames`. */
  private readonly bus = new EventBus();
  private readonly channels: ReadonlySet<keyof EventMap>;
  /** The resources whose scopes are held, each with how many hold it. */
  private readonly scopeRefCounts = new Map<ResourceId, number>();
  private readonly schedule: readonly FaultAction[];
  private readonly makeResponse: (op: BusOperationKey, payload: Record<string, unknown>) => unknown;
  private readonly replyQueues = new Map<BusOperationKey, unknown[]>();
  private requestCount = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(cfg: FaultyTransportConfig) {
    this.channels = new Set(cfg.channels);
    this.schedule = cfg.schedule ?? [];
    this.makeResponse = cfg.makeResponse ?? refuseUnscriptedOperation;
  }

  /**
   * Queue responses for `op`, consumed FIFO — one per request that reaches
   * the simulated gateway — before falling back to `makeResponse`. The queue
   * scripts the GATEWAY; the fault schedule scripts the WIRE. Consequences,
   * deliberately: `duplicate-reply` replays one entry's body twice, and a
   * `drop-reply` still consumes its entry (the gateway answered; the wire ate
   * it) — so "first reply lost, the retry sees the NEXT page" is expressible.
   * `reject-emit` consumes nothing: that request never reached the gateway.
   *
   * Each entry is a `response`. A reply that names what it answers for beside
   * its response (`REPLY_NAMES`: the resource a context was gathered for, the
   * reference a search was for) takes that from its request, as a gateway's
   * does: a test queues the response alone.
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
    envelope?: BusEnvelope,
  ): Promise<number | undefined> {
    // The double models exactly one connected participant, so a delivered
    // emit reports `1`; post-dispose it is inert and reports no count.
    if (this.disposed) return undefined;
    const name = channel as string;
    if (!isOperation(name)) {
      // Non-request channel: forward as-is (scoped or global).
      const target = envelope?.scope === undefined ? this.bus : this.bus.scope(envelope!.scope);
      // `scope` is not repeated — targeting the scoped bus IS how it is set.
      target.emit(channel, payload, { correlationId: envelope?.correlationId });
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
      correlationId: envelope?.correlationId,
      retryKey: retryKeyOf(name, record),
      payload: { ...record },
    });

    if (action.kind === 'reject-emit') {
      // Models a /bus/emit 4xx: the request never reaches the bus.
      throw new Error(`FaultyTransport: emit rejected by schedule (reject-emit) on ${name}`);
    }

    // The request itself is observable (handlers-eye view) to a reader of a
    // transport given its channel, then the simulator plays gateway:
    // synthesize the registry reply per the action. The envelope rides along:
    // a handler watching this double must read the same frame it would across
    // a broker.
    this.bus.emit(channel, payload, envelope);

    // The gateway's answer is computed ONCE per request that reaches it —
    // the reply QUEUE scripts the gateway, the fault schedule scripts the
    // wire. So `duplicate-reply` replays the same body twice, and a
    // `drop-reply` still consumes its queue entry: the gateway answered, the
    // wire ate it.
    const queue = this.replyQueues.get(name);
    const response = queue && queue.length > 0 ? queue.shift() : this.makeResponse(name, record);

    // A reply that names what it answers for names what its request did, as a
    // gateway's does. Refused here, where it rejects the emit, rather than in
    // the reply's own microtask, where nobody is awaiting it.
    const named: Record<string, unknown> = {};
    for (const property of REPLY_NAMES[name]) {
      if (record[property] === undefined) {
        throw new Error(
          `FaultyTransport: the reply to ${name} names "${property}", which this request does not state`,
        );
      }
      named[property] = record[property];
    }

    const reply = (): void => {
      if (this.disposed) return;
      const replyPayload = response === undefined ? { ...named } : { ...named, response };
      const resultChannel = BUS_OPERATIONS[name].result as keyof EventMap;
      // The key rides back on the envelope, never inside the reply payload.
      this.bus.emit(resultChannel, replyPayload as EventMap[keyof EventMap], {
        correlationId: envelope?.correlationId,
      });
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

  on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K] | FrameRefusal) => void): () => void {
    const sub = this.stream(channel).subscribe(handler);
    return () => sub.unsubscribe();
  }

  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K] | FrameRefusal> {
    return this.frames(channel).pipe(map((frame) => frame.payload));
  }

  /**
   * The frames on the channel that a wire transport's stream would carry: one
   * of no scope on a channel this transport was given, and one of a
   * resource's scope on a resource-scoped channel while that scope is held.
   * Every other frame is dropped. A stream carries every scope it holds on
   * the one channel, so a reader of one resource's keeps that scope's
   * (`Bus.frames(channel, resourceId)`).
   *
   * A resource-scoped channel is read with no scope held, as a wire
   * transport reads it, and carries nothing until one is. Any other channel
   * not given is refused at the call, as `bus.unsubscribed`: a frame on it
   * could never arrive.
   */
  frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K] | FrameRefusal>> {
    if (!this.channels.has(channel) && !isResourceScopedChannel(channel)) {
      throw new BusRequestError(
        `Transport is not subscribed to ${channel as string} — a frame on it can never arrive on this connection. Give the transport the channel.`,
        'bus.unsubscribed',
        { channel },
      );
    }
    return this.bus.channelStream(channel).pipe(
      filter((frame) =>
        frame.scope === undefined
          ? this.channels.has(channel)
          : isResourceScopedChannel(channel) && this.scopeRefCounts.has(frame.scope),
      ),
    );
  }

  /**
   * Whether the channels this transport was given name `channel`, as a wire
   * transport answers for its stream's global set: a request whose replies
   * they do not name fails at once, as `bus.unsubscribed`.
   */
  isSubscribed(channel: keyof EventMap): boolean {
    return this.channels.has(channel);
  }

  /**
   * Hold `resourceId`'s scope until the returned release, as a wire
   * transport holds it: each acquisition counts, distinct resources compose,
   * the scope is let go at its last release, and a release is idempotent.
   */
  subscribeToResource(resourceId: ResourceId): () => void {
    this.scopeRefCounts.set(resourceId, (this.scopeRefCounts.get(resourceId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const holds = this.scopeRefCounts.get(resourceId);
      // None once the transport is disposed, which let every scope go.
      if (holds === undefined) return;
      if (holds > 1) this.scopeRefCounts.set(resourceId, holds - 1);
      else this.scopeRefCounts.delete(resourceId);
    };
  }

  /**
   * Correlated-reply tracking, exposed for assertions: `Bus.request` registers
   * each cid here before its emit and releases on settle, so a test can pin
   * the tracked set at any point of a request's lifecycle. This double never
   * drops its stream, so it has nothing to replay, and tracking has no
   * behavioral effect.
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

  /**
   * Publish on `bus` what `frames` delivers on the channels this transport
   * was given and on the resource-scoped ones, as a wire transport's bridge
   * does: a resource's frame while its scope is held, with no scope, since
   * the relay carries none.
   */
  bridgeInto(bus: EventBus): void {
    relayFrames(
      this,
      {
        // A payload that is not its channel's is published as its refusal, as a wire transport's bridge does.
        emit: (channel, payload, envelope) => bus.emit(channel, asDeclared(channel, payload, envelope.correlationId), envelope),
      },
      [...this.channels, ...RESOURCE_SCOPED_CHANNELS],
      // `EventBus.emit` is synchronous, so this never fires.
      (channel, error) => {
        throw new Error(`FaultyTransport: the bridge of ${channel as string} failed`, { cause: error });
      },
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scopeRefCounts.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.state$.next('closed');
    this.state$.complete();
    this.errorsSubject.complete();
    // Completes every subject: in-flight busRequests resolve `bus.closed`.
    this.bus.destroy();
  }
}
