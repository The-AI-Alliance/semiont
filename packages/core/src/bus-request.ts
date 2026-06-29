import { Observable, firstValueFrom, merge, throwError, TimeoutError } from 'rxjs';
import { catchError, defaultIfEmpty, filter, map, take, timeout } from 'rxjs/operators';
import { SemiontError } from './errors';
import type { EventMap } from './bus-protocol';
import { BUS_OPERATIONS, type BusOperationKey } from './bus-operations';

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
 * `TResult` stays explicit: reply payload shapes are not uniform across channels
 * (some carry `{ correlationId, response }`, some put data at top level), so it
 * cannot be safely inferred from the result channel. `busRequest` reads
 * `e.response`; the caller annotates the expected `response` type.
 */
export async function busRequest<TResult>(
  bus: BusRequestPrimitive,
  operation: BusOperationKey,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<TResult> {
  const correlationId = crypto.randomUUID();
  const fullPayload = { ...payload, correlationId };
  const { result: resultChannel, failure: failureChannel } = BUS_OPERATIONS[operation];

  const result$ = merge(
    (bus.stream(resultChannel as keyof EventMap) as Observable<Record<string, unknown>>).pipe(
      filter((e) => e.correlationId === correlationId),
      map((e) => ({ ok: true as const, response: e.response as TResult })),
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

  // No guard around emit: an emit rejection propagates to the caller
  // naturally, and `result$`'s `defaultIfEmpty` guarantees `resultPromise`
  // *resolves* (never rejects) when the bus is disposed before a reply — so it
  // cannot leak an unhandled rejection regardless of whether anyone awaits it.
  await bus.emit(operation as keyof EventMap, fullPayload as EventMap[keyof EventMap]);

  const result = await resultPromise;
  if (!result.ok) {
    throw result.error;
  }
  return result.response;
}
