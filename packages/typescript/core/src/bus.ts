/**
 * The typed bus over a transport: what a client hands out as `client.wire`,
 * as Rust's `semiont::bus::Bus` (`client.wire()`) and Python's
 * `semiont.bus.Bus` (`client.wire`) are. What it emits goes over the wire,
 * and what it reads is what the wire delivers. A client's own in-process
 * signals (`beckon:hover`, `mark:requested`, the selections) never cross the
 * wire: they are on the client's own bus, `client.bus`.
 *
 * Three verbs:
 *
 * - `emit` sends a frame on a channel.
 * - `frames` reads a channel's frames, each with its envelope, who emitted
 *   it and the trace it was sent under. A channel of a resource's scope is
 *   read for one resource: the read holds that resource's scope while it is
 *   read, and is given that resource's frames and no other's. Read with no
 *   resource, such a channel does not compile, and is refused when called;
 *   so is any other channel read for a resource.
 * - `request` sends an operation's request and awaits its reply.
 */

import { Observable, firstValueFrom, merge, race, throwError, TimeoutError } from 'rxjs';
import { catchError, defaultIfEmpty, filter, map, take, timeout } from 'rxjs/operators';
import { CHANNEL_STAMPS, type EventMap } from './bus-protocol';
import type { BusEnvelope, BusFrame, TraceCarrier } from './event-bus';
import type { ConnectionState } from './transport';
import { BUS_OPERATIONS, RESULT_PAYLOADS, type BusOperationKey } from './bus-operations';
import { BusRequestError, classifyFailureCode, type BusReply } from './bus-request';
import { SemiontError } from './errors';
import { lackingOf, type Shape } from './required';
import { BUS_REQUEST_TIMEOUT_MS } from './generated/client-timing';
import { isResourceScopedChannel, type ResourceScopedChannel, type UnscopedChannel } from './bridged-channels';
import { uuidV4 } from './id-generation';
import { userId, type ResourceId, type UserId } from './identifiers';

/**
 * What a bus is built over: the part of a transport (`ITransport`) its three
 * verbs use. Every transport has it, and so can a bus in one process, which
 * delivers what it is sent without a wire.
 */
export interface BusPrimitive {
  /**
   * Matches `ITransport.emit`'s return: the subscriber count, absent when
   * there is none. A request ignores it — the reply channel is its ack — but
   * the primitive must stay assignable from every ITransport.
   */
  emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    envelope?: BusEnvelope,
  ): Promise<number | undefined>;
  /**
   * The ENVELOPE view: every frame the transport delivers on a channel,
   * whatever its scope. A request matches its reply on `frame.correlationId`,
   * which is why the key never needs to enter a channel's domain type.
   * Required, not optional: every transport can answer it, and an optional
   * member here would be one interface in two dialects — the
   * capability-sniffing compatibility layer that a required `isSubscribed`
   * exists to rule out.
   */
  frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>>;
  /** The payload view, DERIVED from `frames` so the two cannot disagree. */
  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]>;
  /**
   * Connection state of the stream that carries replies. Required, not
   * optional: a request gates its emit on this — no correlated emit before
   * the reply path exists. Implementers back it with a `BehaviorSubject`, so
   * the current state arrives synchronously on subscribe; a bus that cannot
   * lose replies (in-process) reports `'open'` until disposal.
   */
  state$: Observable<ConnectionState>;
  /**
   * Correlated-reply retention, client side. A request registers its
   * correlationId here BEFORE emitting and calls the returned disposer on
   * every settle path; a wire transport includes the currently-tracked ids
   * as `pendingReplies` in each subscribe body, so a reply published while
   * the connection was down is replayed from the server's retention buffer
   * on reconnect. Required, not optional, for the reason `frames` and
   * `isSubscribed` are: an in-process bus that cannot lose a reply returns a
   * disposer that does nothing, and a request has one path.
   */
  trackReply(correlationId: string): () => void;
  /**
   * Whether this transport's receive path delivers `channel` — i.e. a reply
   * published there can actually reach this process. A transport whose
   * subscription set is narrowed (a worker subscribing only the reply
   * channels it awaits) answers from that set, so a request on a channel
   * outside it fails fast with `bus.unsubscribed` instead of burning its
   * timeout on a reply that could never arrive.
   *
   * REQUIRED. An in-process bus answers `true` for every channel,
   * because it delivers every emit — that is the true answer, not a stub.
   * An optional member would be a compatibility layer: a request would
   * branch on whether the method exists, so the check would run or not
   * according to which implementation it held rather than according to what
   * is true.
   *
   * Answers for the GLOBAL subscription set only. Correlated replies always
   * ride global channels, so a scope-only subscription cannot deliver one —
   * which is why a transport's `stream` refusal asks the wider question
   * (global OR any scope) separately rather than reusing this.
   *
   * Registry keys, not strings: asking about a channel `EventMap` does not
   * declare has no useful answer, and a request only ever asks about reply
   * channels it derived from the registry in the first place.
   */
  isSubscribed(channel: keyof EventMap): boolean;
  /**
   * Take one hold on a resource's scope; the returned disposer lets it go.
   * Holds of one resource are counted, and distinct resources compose on one
   * connection. A transport with no wire may deliver without scoping.
   */
  subscribeToResource(resourceId: ResourceId): () => void;
}

/**
 * A frame of one channel as a bus delivers it: its payload, its envelope,
 * who emitted it as the gateway stamped it, and the trace it was sent under.
 * The same fields Rust's and Python's `Delivered` have.
 */
export interface Delivered<T> {
  readonly payload: T;
  /** Correlates a reply with its request. Absent on an announcement. */
  readonly correlationId?: string;
  /** The resource scope the frame was delivered on. Absent means global. */
  readonly scope?: ResourceId;
  /** Who emitted it, as the gateway stamped it (`_userId`). Absent on a frame of this process. */
  readonly userId?: UserId;
  /** The trace it was sent under, when it carried one. */
  readonly trace?: TraceCarrier;
}

/** The field the gateway stamps a payload's emitter in. */
const EMITTED_BY = '_userId';

/**
 * `payload` as `channel` types it. A stamp the gateway put on it that the
 * channel's payload type does not declare (`CHANNEL_STAMPS`) is the bus's, not
 * the payload's, and is left out: the rule every SDK's typed read keeps.
 */
export function asDeclared<K extends keyof EventMap>(channel: K, payload: EventMap[K]): EventMap[K] {
  if (typeof payload !== 'object' || payload === null) return payload;
  const declared: readonly string[] = CHANNEL_STAMPS[channel];
  return Object.fromEntries(
    Object.entries(payload).filter(([name]) => !name.startsWith('_') || declared.includes(name)),
  ) as EventMap[K];
}

function delivered<K extends keyof EventMap>(channel: K, frame: BusFrame<EventMap[K]>): Delivered<EventMap[K]> {
  const stamped = (frame.payload as Record<string, unknown>)[EMITTED_BY];
  return {
    payload: asDeclared(channel, frame.payload),
    ...(frame.correlationId !== undefined ? { correlationId: frame.correlationId } : {}),
    ...(frame.scope !== undefined ? { scope: frame.scope } : {}),
    ...(typeof stamped === 'string' ? { userId: userId(stamped) } : {}),
    ...(frame.trace !== undefined ? { trace: frame.trace } : {}),
  };
}

/**
 * What the result of `operation` must carry: the payload of the schema its
 * registry entry names, or a `response` that is one.
 */
function resultShape(operation: BusOperationKey): Shape {
  const declared = RESULT_PAYLOADS[operation];
  if ('payload' in declared) return { ref: declared.payload };
  if ('response' in declared) return { required: ['response'], members: { response: { ref: declared.response } } };
  return {};
}

/** Fails with the signal's reason when its owner abandons the request; says nothing until then. */
function abandonment(signal: AbortSignal): Observable<never> {
  return new Observable<never>((subscriber) => {
    const abandon = () => subscriber.error(signal.reason);
    signal.addEventListener('abort', abandon, { once: true });
    return () => signal.removeEventListener('abort', abandon);
  });
}

/** See the module's documentation. */
export class Bus {
  readonly #transport: BusPrimitive;

  constructor(transport: BusPrimitive) {
    this.#transport = transport;
  }

  /**
   * Send `payload` on `channel`. Resolves with the number of subscribers the
   * emit reached, or with nothing when there is no count to give.
   */
  emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    envelope?: BusEnvelope,
  ): Promise<number | undefined> {
    return this.#transport.emit(channel, payload, envelope);
  }

  /** The frames delivered on `channel` from now on. */
  frames<K extends UnscopedChannel>(channel: K): Observable<Delivered<EventMap[K]>>;
  /**
   * The frames delivered on `channel` for `resourceId` from now on. The read
   * holds that resource's scope until it is unsubscribed, and is given that
   * resource's frames and no other's.
   */
  frames<K extends ResourceScopedChannel>(channel: K, resourceId: ResourceId): Observable<Delivered<EventMap[K]>>;
  frames<K extends keyof EventMap>(channel: K, resourceId?: ResourceId): Observable<Delivered<EventMap[K]>> {
    if (resourceId === undefined) {
      if (isResourceScopedChannel(channel)) {
        throw new TypeError(
          `${channel} is delivered on a resource's scope, so a read of it names the resource: frames(channel, resourceId)`,
        );
      }
      return this.#transport.frames(channel).pipe(map((frame) => delivered(channel, frame)));
    }
    if (!isResourceScopedChannel(channel)) {
      throw new TypeError(`${channel} is no resource's channel: frames(channel)`);
    }
    const transport = this.#transport;
    return new Observable<Delivered<EventMap[K]>>((subscriber) => {
      const leave = transport.subscribeToResource(resourceId);
      // A stream carries every scope it holds on the one channel, and another
      // reader may hold another resource's.
      const reading = transport
        .frames(channel)
        .pipe(
          filter((frame) => frame.scope === resourceId),
          map((frame) => delivered(channel, frame)),
        )
        .subscribe(subscriber);
      return () => {
        reading.unsubscribe();
        leave();
      };
    });
  }

  /**
   * Request/reply over the bus, keyed by the operation's request channel.
   *
   * The `operation` is a `BusOperationKey` (a request channel declared in
   * `BUS_OPERATIONS`); the matching `result`/`failure` reply channels are
   * looked up from the registry, so a caller cannot pass a mismatched or
   * unbridged reply pair — the unbridged-reply bug class is
   * unrepresentable. Every registry reply derives into `BRIDGED_CHANNELS`
   * (see bridged-channels.ts), so a transport on the default channel set
   * subscribes to it (an unbridged reply pair gives no compile/runtime
   * signal).
   *
   * The return type is INFERRED from the registry (`BusReply<Op>` = the
   * result channel's `response` type, or `void`) — callers never annotate it.
   * A result reply is a frame whose envelope carries the request's
   * `correlationId` and whose payload is `{ response: T }` (data) or `{}`
   * (void); the request matches on the envelope and reads `payload.response`.
   * A result that lacks a member its schema requires (`RESULT_PAYLOADS`)
   * rejects, as a `SemiontError` coded `error` naming the member.
   *
   * `signal` lets the caller ABANDON the request. Abandoned, it rejects with
   * the signal's reason, as an abortable API does, and that is all it does:
   * what was already sent stays sent, the reply stops being tracked, and a
   * reply that arrives later is reported to nobody. Abandoned before the
   * stream that carries its reply opened, it sends nothing. The rejection
   * carries no `BusRequestErrorCode`: it states the caller's own act, not a
   * failure.
   */
  async request<Op extends BusOperationKey>(
    operation: Op,
    payload: Record<string, unknown>,
    timeoutMs = BUS_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<BusReply<Op>> {
    const bus = this.#transport;
    signal?.throwIfAborted();
    const correlationId = uuidV4();
    const { result: resultChannel, failure: failureChannel } = BUS_OPERATIONS[operation];

    // A transport with a narrowed subscription set (a worker) that is not
    // subscribed to this operation's reply channels can never deliver the
    // reply — fail loudly NOW, naming the fix, instead of a 30 s timeout
    // that reads as network weather.
    for (const replyChannel of [resultChannel, failureChannel]) {
      if (!bus.isSubscribed(replyChannel)) {
        throw new BusRequestError(
          `Transport is not subscribed to reply channel ${replyChannel as string} — a reply to ${operation} can never arrive. Add this operation's reply channels to the transport's channel set.`,
          'bus.unsubscribed',
          { channel: operation, resultChannel, failureChannel },
        );
      }
    }

    // Matched on the ENVELOPE. The payload is read only for what it means —
    // the response, or the failure's message and code — never for routing. A
    // result that lacks a member its schema requires is refused, as every
    // other SDK refuses it as it decodes it.
    const settled$ = merge(
      bus.frames(resultChannel as keyof EventMap).pipe(
        filter((frame) => frame.correlationId === correlationId),
        map(({ payload: e }) => {
          const lacks = lackingOf(resultShape(operation), e);
          return lacks === undefined
            ? { ok: true as const, response: (e as Record<string, unknown>).response as BusReply<Op> }
            : {
                ok: false as const,
                error: new SemiontError(`a payload on ${resultChannel} is not that channel's: it has no \`${lacks}\``, 'error', {
                  channel: resultChannel,
                  correlationId,
                }),
              };
        }),
      ),
      bus.frames(failureChannel as keyof EventMap).pipe(
        filter((frame) => frame.correlationId === correlationId),
        map(({ payload: p }) => p as Record<string, unknown>),
        map((e) => ({
          ok: false as const,
          error: new BusRequestError((e.message as string) ?? 'Bus request rejected', classifyFailureCode(e.code), {
            channel: failureChannel,
            correlationId,
            payload: e,
          }),
        })),
      ),
    ).pipe(
      take(1),
      timeout(timeoutMs),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(
            () =>
              new BusRequestError(
                `Bus request timed out after ${timeoutMs}ms on ${resultChannel}`,
                'bus.timeout',
                { channel: operation, resultChannel, correlationId, timeoutMs },
              ),
          );
        }
        return throwError(() => err);
      }),
      // If the stream completes with no value — the bus was disposed before a
      // reply (e.g. during `semiont.dispose()` with a request in flight) —
      // resolve to a typed `bus.closed` result instead of letting
      // `firstValueFrom` throw rxjs `EmptyError`. An awaited caller then gets
      // a clean BusRequestError; an in-flight promise nobody is awaiting
      // simply resolves, so it can't surface as an unhandled rejection on
      // dispose.
      defaultIfEmpty({
        ok: false as const,
        error: new BusRequestError(
          `Bus closed before a reply on ${resultChannel}`,
          'bus.closed',
          { channel: operation, resultChannel, correlationId },
        ),
      }),
    );

    // Subscribe before emitting so we don't miss an instantaneous reply
    // (which can happen with an in-process bus).
    const resultPromise = firstValueFrom(signal ? race(settled$, abandonment(signal)) : settled$);
    // It rejects on a timeout or an abandonment, and is read only where it is
    // awaited, at the tail. Every path that leaves before then — a closed
    // bus, a refused emit — leaves it rejected with nobody holding it, which a
    // Node process treats as fatal. Marked handled once, here; the await at
    // the tail still throws what it rejected with.
    resultPromise.catch(() => {});

    // ── Attach gate ─────────────────────────────────────────────────────────
    // No correlated emit before the reply path exists: an emit accepted (202)
    // and answered while the session's subscribe stream has not attached
    // publishes its reply to nobody. Wait, inside the SAME deadline (the
    // timeout operator above is already ticking), for the transport to report
    // the one deliverable state. Only `'open'` delivers; `'degraded'` is a
    // dropped stream by definition and waits like `connecting`/`reconnecting`.
    // `'closed'` fails fast — a request against a closed bus should not burn a
    // timeout.
    const closedBeforeEmit = () =>
      new BusRequestError(`Bus closed before emit on ${operation}`, 'bus.closed', {
        channel: operation,
        correlationId,
      });

    // Synchronous fast path: `state$` is BehaviorSubject-backed (see the
    // interface contract), so the current state lands during subscribe.
    // Already `'open'` → fall straight through to the emit with zero added
    // microtasks — the gate can only remove latency, never add it.
    let currentState: ConnectionState | undefined;
    bus.state$.subscribe((s) => {
      currentState = s;
    }).unsubscribe();

    if (currentState === 'closed') {
      throw closedBeforeEmit();
    }
    let emitAllowed = currentState === 'open';
    if (!emitAllowed) {
      const gate = firstValueFrom(
        bus.state$.pipe(
          filter((s) => s === 'open' || s === 'closed'),
          take(1),
          // `state$` completed without ever attaching: treat as closed.
          defaultIfEmpty('closed' as ConnectionState),
        ),
      );
      const outcome = await Promise.race([
        gate,
        // Either settlement of the reply machinery means "stop waiting, never
        // emit": its timeout rejecting `bus.timeout` at `timeoutMs` (one
        // deadline, measured from the call), or its streams completing into
        // the `bus.closed` default above. The shared tail below carries it.
        resultPromise.then(
          () => 'settled' as const,
          () => 'settled' as const,
        ),
      ]);
      if (outcome === 'closed') {
        throw closedBeforeEmit();
      }
      // 'open' → the one emit below. 'settled' → skip the emit; awaiting the
      // reply at the tail rethrows its outcome. (Emit-exactly-once holds
      // structurally either way: nothing subscribes to state$ past this
      // point, so a flap after emission cannot re-emit.)
      emitAllowed = outcome === 'open';
    }

    // An emit rejection (e.g. /bus/emit 4xx) propagates to the caller.
    //
    // Reply tracking, the client side of correlated-reply retention: register
    // the cid BEFORE the emit — a reconnect body built while the emit is in
    // flight must already carry it in `pendingReplies`, or a reply published
    // in the old-connection-death → new-connection-open gap sits in the
    // server's retention buffer unasked-for. Released on every settle path;
    // the never-emitted paths above (closed fast-fail, 'settled' race arm)
    // never reach this line, so they never track.
    let releaseTracking: (() => void) | undefined;
    if (emitAllowed) {
      releaseTracking = bus.trackReply(correlationId);
      try {
        // The key goes on the ENVELOPE. A responder reads it from there and
        // echoes it back on one; no channel's domain type ever carries it.
        await bus.emit(operation as keyof EventMap, payload as EventMap[keyof EventMap], { correlationId });
      } catch (emitError) {
        releaseTracking?.();
        releaseTracking = undefined;
        throw emitError;
      }
    }

    try {
      const result = await resultPromise;
      if (!result.ok) {
        throw result.error;
      }
      return result.response;
    } finally {
      releaseTracking?.();
    }
  }
}
