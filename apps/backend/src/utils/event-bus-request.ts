/**
 * EventBus Request-Response Helper
 *
 * Provides the correlationId-based request-response pattern for routes
 * that delegate to EventBus actors (Gatherer, Matcher, CloneTokenManager).
 *
 * Pattern: emit request with correlationId → await success or failure event
 * matching that correlationId → return response or throw.
 */

import { firstValueFrom, merge } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';
import type { EventBus, EventMap } from '@semiont/core';

type EventName = keyof EventMap;

/**
 * Send a request event and await a correlated response or failure.
 *
 * @param eventBus - The EventBus instance
 * @param requestEvent - Event name to emit
 * @param payload - Event payload (must include correlationId)
 * @param successEvent - Event name for successful response
 * @param failureEvent - Event name for failure
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 * @returns The response field from the success event
 */
export async function eventBusRequest<
  TReq extends EventName,
  TSuccess extends EventName,
  TFailure extends EventName,
>(
  eventBus: EventBus,
  requestEvent: TReq,
  payload: EventMap[TReq],
  successEvent: TSuccess,
  failureEvent: TFailure,
  timeoutMs = 30_000,
): Promise<(EventMap[TSuccess] & { response: any })['response']> {
  const correlationId = (payload as any).correlationId as string;

  // Subscribe before emitting so synchronous responses are captured
  const result$ = merge(
    eventBus.get(successEvent).pipe(
      filter((e: any) => e.correlationId === correlationId),
      map((e: any) => ({ ok: true as const, response: e.response })),
    ),
    eventBus.get(failureEvent).pipe(
      filter((e: any) => e.correlationId === correlationId),
      map((e: any) => ({ ok: false as const, error: new Error(e.message) })),
    ),
  ).pipe(take(1), timeout(timeoutMs));

  // firstValueFrom subscribes eagerly — must be called before .next()
  const resultPromise = firstValueFrom(result$);

  // Emit the request (handler may respond synchronously)
  (eventBus.get(requestEvent) as any).next(payload);

  const result = await resultPromise;
  if (!result.ok) {
    throw result.error;
  }
  return result.response;
}
