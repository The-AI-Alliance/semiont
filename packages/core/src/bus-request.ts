import { Observable, firstValueFrom, merge, throwError, TimeoutError } from 'rxjs';
import { catchError, defaultIfEmpty, filter, map, take, timeout } from 'rxjs/operators';
import { SemiontError } from './errors';
import type { EventMap, EventName } from './bus-protocol';
import { BUS_OPERATIONS, type BusOperationKey } from './bus-operations';

/**
 * The value a registered operation resolves to: the `response` field of its
 * result channel's payload, or `void` for a result channel that carries no
 * `response` (a confirmed-write ack with no data). Inferred from the registry,
 * so callers never annotate `busRequest`'s return type. Relies on the reply-shape
 * standard — see .plans/REPLY-SHAPE-STANDARD.md.
 */
export type BusReply<Op extends BusOperationKey> =
  EventMap[(typeof BUS_OPERATIONS)[Op]['result'] & EventName] extends { response: infer R }
    ? R
    : void;

export type BusRequestErrorCode =
  | 'bus.timeout'
  | 'bus.rejected'
  | 'bus.closed'
  | 'bus.bad-payload'
  | 'bus.unauthorized'
  | 'bus.forbidden'
  | 'bus.not-found';

export class BusRequestError extends SemiontError {
  declare code: BusRequestErrorCode;

  constructor(message: string, code: BusRequestErrorCode, details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'BusRequestError';
  }
}

/**
 * Subset of ITransport that `busRequest` needs: a way to send a command and
 * a way to observe channels. Generic enough that an in-process transport
 * can satisfy it without round-tripping through HTTP.
 */
export interface BusRequestPrimitive {
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<void>;
  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]>;
}

/**
 * Request/reply over the bus, keyed by the operation's request channel.
 *
 * The `operation` is a `BusOperationKey` (a request channel declared in
 * `BUS_OPERATIONS`); the matching `result`/`failure` reply channels are looked
 * up from the registry, so a caller cannot pass a mismatched or unbridged reply
 * pair — the recurring unbridged-reply bug class is unrepresentable. Every
 * registry reply derives into `BRIDGED_CHANNELS` (see bridged-channels.ts), so
 * the transport always subscribes to it (cf.
 * .plans/bugs/gather-resource-complete-not-bridged.md, where the `gather:resource-*`
 * pair shipped unbridged with no compile/runtime signal).
 *
 * The return type is INFERRED from the registry (`BusReply<Op>` = the result
 * channel's `response` type, or `void`) — callers never annotate it. Every reply
 * is `{ correlationId, response: T }` (data) or `{ correlationId }` (void); see
 * .plans/REPLY-SHAPE-STANDARD.md. `busRequest` reads `e.response`.
 */
export async function busRequest<Op extends BusOperationKey>(
  bus: BusRequestPrimitive,
  operation: Op,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<BusReply<Op>> {
  const correlationId = crypto.randomUUID();
  const fullPayload = { ...payload, correlationId };
  const { result: resultChannel, failure: failureChannel } = BUS_OPERATIONS[operation];

  const result$ = merge(
    (bus.stream(resultChannel as keyof EventMap) as Observable<Record<string, unknown>>).pipe(
      filter((e) => e.correlationId === correlationId),
      map((e) => ({ ok: true as const, response: e.response as BusReply<Op> })),
    ),
    (bus.stream(failureChannel as keyof EventMap) as Observable<Record<string, unknown>>).pipe(
      filter((e) => e.correlationId === correlationId),
      map((e) => ({
        ok: false as const,
        error: new BusRequestError((e.message as string) ?? 'Bus request rejected', 'bus.rejected', {
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
    // See .plans/bugs/busrequest-emptyerror-on-dispose.md.
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
  const resultPromise = firstValueFrom(result$);

  // An emit rejection (e.g. /bus/emit 4xx) propagates to the caller — but the
  // caller then never awaits `resultPromise`, which is already subscribed and
  // will REJECT with `bus.timeout` at `timeoutMs` (the request never left, so
  // no reply can save it). Detach it before rethrowing so the doomed promise
  // can't surface later as an unhandled rejection. (`defaultIfEmpty` covers
  // only the disposed-bus case, where the stream completes and the promise
  // *resolves* `bus.closed`.) Found by the liveness harness's reject-emit
  // schedules (.plans/LIVENESS-AXIOMS.md, P1).
  try {
    await bus.emit(operation as keyof EventMap, fullPayload as EventMap[keyof EventMap]);
  } catch (emitError) {
    resultPromise.catch(() => {});
    throw emitError;
  }

  const result = await resultPromise;
  if (!result.ok) {
    throw result.error;
  }
  return result.response;
}
