import { Observable, firstValueFrom, merge, race, throwError, TimeoutError } from 'rxjs';
import { catchError, defaultIfEmpty, filter, map, take, timeout } from 'rxjs/operators';
import { SemiontError } from './errors';
import type { EventMap, EventName } from './bus-protocol';
import type { BusEnvelope, BusFrame } from './event-bus';
import type { ConnectionState } from './transport';
import { BUS_OPERATIONS, type BusOperationKey } from './bus-operations';
import type { CommandErrorCode } from './payload-types';
import { busRequestCodeByWireCode, unrecognizedFailureCode, type BusRequestErrorCode } from './generated/error-codes';
import { BUS_REQUEST_TIMEOUT_MS } from './generated/client-timing';
import { uuidV4 } from './id-generation';

/**
 * The value a registered operation resolves to: the `response` field of its
 * result channel's payload, or `void` for a result channel that carries no
 * `response` (a confirmed-write ack with no data). Inferred from the registry,
 * so callers never annotate `busRequest`'s return type. Relies on the reply-shape
 * standard.
 */
export type BusReply<Op extends BusOperationKey> =
  EventMap[(typeof BUS_OPERATIONS)[Op]['result'] & EventName] extends { response: infer R }
    ? R
    : void;

/**
 * What a failed `busRequest` can tell its caller: `BusRequestErrorCode`,
 * generated from specs/src/errors/codes.json, where each member is documented.
 *
 * Two kinds of member, and the split is the point. `bus.not-found`,
 * `bus.peer-unavailable`, `bus.unauthorized` and `bus.none-pending` are facts
 * the PEER stated, promoted from `CommandError.code` by the table's `wire`
 * entries. The rest are facts only this side knows — a timeout, a closed
 * connection, a local misconfiguration — which is why the two vocabularies stay
 * separate rather than collapsing into one.
 *
 * There is no `bus.bad-payload` or `bus.forbidden`: nothing produces either,
 * and the HTTP-shaped facts they would name live in `TransportErrorCode` with
 * a real producer (`transportErrorCodeForStatus`). A member nothing can emit
 * promises a distinction the system cannot make. `bus.unauthorized` is a
 * member because it has a producer: the dispatcher refusing a `job:claim`
 * from a caller without the worker role.
 *
 * The mapping has one site, the table. Left unmapped, a consumer would reach
 * into `details.payload.code` and there would be two ways to ask the same
 * question. The generator refuses a table that leaves a wire code unmapped, and
 * `satisfies` repeats that here against the generated `CommandErrorCode`, so a
 * stale generated file fails to compile rather than defaulting to
 * `bus.rejected`.
 */
const WIRE_CODES = new Map<unknown, BusRequestErrorCode>(
  Object.entries(busRequestCodeByWireCode satisfies Record<CommandErrorCode, BusRequestErrorCode>),
);

/**
 * Read as `unknown`, because that is what crosses the boundary: the value comes
 * from a peer that may be newer than this build. An unrecognized code degrades
 * to the table's `unrecognizedFailure` rather than being trusted through —
 * inventing a `BusRequestErrorCode` nobody handles is worse than the honest
 * fallback.
 */
function classifyFailureCode(code: unknown): BusRequestErrorCode {
  return WIRE_CODES.get(code) ?? unrecognizedFailureCode;
}

const CLIENT_TO_WIRE = new Map<BusRequestErrorCode, CommandErrorCode>(
  (Object.entries(busRequestCodeByWireCode) as [CommandErrorCode, BusRequestErrorCode][]).map(([wire, client]) => [client, wire]),
);

/**
 * The wire code a failed request's peer stated, for a service that answers its
 * own caller with that failure: `peer-unavailable` from a read it depended on
 * reaches the caller as `peer-unavailable`. A failure only this side knows — a
 * timeout, a closed bus — states no wire code, and neither does anything that
 * is not a `BusRequestError`.
 */
export function relayedFailureCode(error: unknown): CommandErrorCode | undefined {
  return error instanceof BusRequestError ? CLIENT_TO_WIRE.get(error.code) : undefined;
}

export class BusRequestError extends SemiontError {
  declare code: BusRequestErrorCode;

  constructor(message: string, code: BusRequestErrorCode, details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'BusRequestError';
  }
}

/**
 * The reply channels — result and failure — of every operation in
 * `channels`, deduplicated. Entries that are not operation request channels
 * (broadcast signals, domain events) contribute nothing.
 *
 * This is THE derivation for a narrowed-subscription transport profile
 * (`HttpTransportConfig.channels`: subscribe exactly the reply channels of
 * the operations a process awaits) and for a service's outbound reply pump
 * (forward exactly the replies of the operations it answers). Restating a
 * reply channel by hand is the unbridged-reply bug class.
 */
export function replyChannelsFor(channels: readonly string[]): EventName[] {
  const out = new Set<EventName>();
  for (const ch of channels) {
    const op = BUS_OPERATIONS[ch as BusOperationKey];
    if (!op) continue;
    out.add(op.result);
    out.add(op.failure);
  }
  return [...out];
}

/**
 * Subset of ITransport that `busRequest` needs: a way to send a command and
 * a way to observe channels. Generic enough that an in-process transport
 * can satisfy it without round-tripping through HTTP.
 */
export interface BusRequestPrimitive {
  /**
   * Matches `ITransport.emit`'s return: the subscriber count, absent when
   * there is none. `busRequest` itself ignores it — the reply channel is its
   * ack — but the primitive must stay assignable from every ITransport.
   */
  emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    envelope?: BusEnvelope,
  ): Promise<number | undefined>;
  /**
   * The ENVELOPE view. `busRequest` matches a reply on `frame.correlationId`,
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
   * optional: `busRequest` gates its emit on
   * this — no correlated emit before the reply path exists. Implementers back
   * it with a `BehaviorSubject`, so the current state arrives synchronously
   * on subscribe; a transport that cannot lose replies (in-process) reports
   * `'open'` until disposal.
   */
  state$: Observable<ConnectionState>;
  /**
   * Correlated-reply retention, client side. `busRequest` registers its correlationId here
   * BEFORE emitting and calls the returned disposer on every settle path;
   * a wire transport includes the currently-tracked ids as
   * `pendingReplies` in each subscribe body, so a reply published while
   * the connection was down is replayed from the server's retention
   * buffer on reconnect. Required, not optional, for the reason `frames`
   * and `isSubscribed` are: an in-process transport that cannot lose a reply
   * returns a disposer that does nothing, and `busRequest` has one path.
   */
  trackReply(correlationId: string): () => void;
  /**
   * Whether this transport's receive path delivers `channel` — i.e. a reply
   * published there can actually reach this process. A transport whose
   * subscription set is narrowed (a worker subscribing only the reply
   * channels it awaits) answers from that set, so `busRequest` on a channel
   * outside it fails fast with `bus.unsubscribed` instead of burning its
   * timeout on a reply that could never arrive.
   *
   * REQUIRED. An in-process transport answers `true` for every channel,
   * because it delivers every emit — that is the true answer, not a stub.
   * An optional member would be a compatibility layer: `busRequest` would
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
   * declare has no useful answer, and `busRequest` only ever asks about
   * reply channels it derived from the registry in the first place.
   */
  isSubscribed(channel: keyof EventMap): boolean;
}

/** Fails with the signal's reason when its owner abandons the request; says nothing until then. */
function abandonment(signal: AbortSignal): Observable<never> {
  return new Observable<never>((subscriber) => {
    const abandon = () => subscriber.error(signal.reason);
    signal.addEventListener('abort', abandon, { once: true });
    return () => signal.removeEventListener('abort', abandon);
  });
}

/**
 * Request/reply over the bus, keyed by the operation's request channel.
 *
 * The `operation` is a `BusOperationKey` (a request channel declared in
 * `BUS_OPERATIONS`); the matching `result`/`failure` reply channels are looked
 * up from the registry, so a caller cannot pass a mismatched or unbridged reply
 * pair — the unbridged-reply bug class is unrepresentable. Every
 * registry reply derives into `BRIDGED_CHANNELS` (see bridged-channels.ts), so
 * a transport on the default channel set subscribes to it (an unbridged reply
 * pair gives no compile/runtime signal).
 *
 * The return type is INFERRED from the registry (`BusReply<Op>` = the result
 * channel's `response` type, or `void`) — callers never annotate it. A result
 * reply is a frame whose envelope carries the request's `correlationId` and
 * whose payload is `{ response: T }` (data) or `{}` (void); `busRequest` matches
 * on the envelope and reads `payload.response`.
 *
 * `signal` lets the caller ABANDON the request. Abandoned, it rejects with the
 * signal's reason, as an abortable API does, and that is all it does: what
 * was already sent stays sent, the reply stops being tracked, and a reply
 * that arrives later is reported to nobody. Abandoned before the stream that
 * carries its reply opened, it sends nothing. The rejection carries no
 * `BusRequestErrorCode`: it states the caller's own act, not a failure.
 */
export async function busRequest<Op extends BusOperationKey>(
  bus: BusRequestPrimitive,
  operation: Op,
  payload: Record<string, unknown>,
  timeoutMs = BUS_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<BusReply<Op>> {
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
  // the response, or the failure's message and code — never for routing.
  const settled$ = merge(
    bus.frames(resultChannel as keyof EventMap).pipe(
      filter((frame) => frame.correlationId === correlationId),
      map(({ payload: e }) => ({
        ok: true as const,
        response: (e as Record<string, unknown>).response as BusReply<Op>,
      })),
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
    // resolve to a typed `bus.closed` result instead of letting `firstValueFrom`
    // throw rxjs `EmptyError`. An awaited caller then gets a clean
    // BusRequestError; an in-flight promise nobody is awaiting simply resolves,
    // so it can't surface as an unhandled rejection on dispose.
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
  // (which can happen with an in-process LocalTransport bus).
  const resultPromise = firstValueFrom(signal ? race(settled$, abandonment(signal)) : settled$);
  // It rejects on a timeout or an abandonment, and is read only where it is
  // awaited, at the tail. Every path that leaves before then — a closed bus, a
  // refused emit — leaves it rejected with nobody holding it, which a Node
  // process treats as fatal. Marked handled once, here; the await at the tail
  // still throws what it rejected with.
  resultPromise.catch(() => {});

  // ── Attach gate ───────────────────────────────────────────────────────────
  // No correlated emit before the reply path exists: an emit accepted (202)
  // and answered while the session's subscribe stream has not attached
  // publishes its reply to nobody. Wait, inside the SAME deadline (the
  // timeout operator above is already ticking), for the transport to report
  // the one deliverable state. Only `'open'` delivers;
  // `'degraded'` is a dropped stream by definition and waits like
  // `connecting`/`reconnecting`. `'closed'` fails fast — a request against a
  // closed bus should not burn a timeout.
  const closedBeforeEmit = () =>
    new BusRequestError(`Bus closed before emit on ${operation}`, 'bus.closed', {
      channel: operation,
      correlationId,
    });

  // Synchronous fast path: `state$` is BehaviorSubject-backed (see the
  // interface contract), so the current state lands during subscribe. Already
  // `'open'` → fall straight through to the emit with zero added microtasks —
  // the gate can only remove latency, never add it.
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
      // deadline, measured from the call), or its streams completing into the
      // `bus.closed` default above. The shared tail below carries it.
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
    // structurally either way: nothing subscribes to state$ past this point,
    // so a flap after emission cannot re-emit.)
    emitAllowed = outcome === 'open';
  }

  // An emit rejection (e.g. /bus/emit 4xx) propagates to the caller.
  //
  // Reply tracking, the client side of correlated-reply retention: register
  // the cid BEFORE the emit — a reconnect body built while the emit is in
  // flight must already carry it in `pendingReplies`, or a reply published in
  // the old-connection-death → new-connection-open gap sits in the server's
  // retention buffer unasked-for. Released on every settle path; the
  // never-emitted paths above (closed fast-fail, 'settled' race arm) never
  // reach this line, so they never track.
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
