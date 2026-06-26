import { Observable, firstValueFrom, merge, throwError, TimeoutError } from 'rxjs';
import { catchError, defaultIfEmpty, filter, map, take, timeout } from 'rxjs/operators';
import { SemiontError, type EventMap, type BridgedChannel, type EmittableChannel } from '@semiont/core';

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
 * Request/reply over the bus. The channel params are typed to the right subsets
 * of `EventName` (see the family note in `@semiont/core` bus-protocol.ts) so a
 * mistyped channel is a compile error, not a silent 30 s timeout:
 *
 * - `emitChannel` is an `EmittableChannel` — the request carries a payload the
 *   `/bus/emit` gateway validates; this catches a typo'd request channel.
 * - `resultChannel`/`failureChannel` are `BridgedChannel` — a reply channel MUST
 *   be in `BRIDGED_CHANNELS` or the transport never subscribes to it and the
 *   request hangs (see .plans/bugs/gather-resource-complete-not-bridged.md — the
 *   `gather:resource-*` pair shipped unbridged with no compile/runtime signal).
 */
export async function busRequest<TResult>(
  bus: BusRequestPrimitive,
  emitChannel: EmittableChannel,
  payload: Record<string, unknown>,
  resultChannel: BridgedChannel,
  failureChannel: BridgedChannel,
  timeoutMs = 30_000,
): Promise<TResult> {
  const correlationId = crypto.randomUUID();
  const fullPayload = { ...payload, correlationId };

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
              { channel: emitChannel, resultChannel, correlationId, timeoutMs },
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
        { channel: emitChannel, resultChannel, correlationId },
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
  await bus.emit(emitChannel as keyof EventMap, fullPayload as EventMap[keyof EventMap]);

  const result = await resultPromise;
  if (!result.ok) {
    throw result.error;
  }
  return result.response;
}
