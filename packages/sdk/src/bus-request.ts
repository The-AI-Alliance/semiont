import { Observable, firstValueFrom, merge, throwError, TimeoutError } from 'rxjs';
import { catchError, filter, map, take, timeout } from 'rxjs/operators';
import { SemiontError, type EventMap } from '@semiont/core';

export type BusRequestErrorCode =
  | 'bus.timeout'
  | 'bus.rejected'
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

export async function busRequest<TResult>(
  bus: BusRequestPrimitive,
  emitChannel: string,
  payload: Record<string, unknown>,
  resultChannel: string,
  failureChannel: string,
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
  );

  const resultPromise = firstValueFrom(result$);

  await bus.emit(emitChannel as keyof EventMap, fullPayload as EventMap[keyof EventMap]);

  const result = await resultPromise;
  if (!result.ok) {
    throw result.error;
  }
  return result.response;
}
