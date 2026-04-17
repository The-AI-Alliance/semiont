import { firstValueFrom, merge } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';
import type { ActorVM } from './view-models/domain/actor-vm';

export class BusRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusRequestError';
  }
}

export async function busRequest<TResult>(
  actor: ActorVM,
  emitChannel: string,
  payload: Record<string, unknown>,
  resultChannel: string,
  failureChannel: string,
  timeoutMs = 30_000,
): Promise<TResult> {
  const correlationId = crypto.randomUUID();
  const fullPayload = { ...payload, correlationId };

  const result$ = merge(
    actor.on$<Record<string, unknown>>(resultChannel).pipe(
      filter((e) => e.correlationId === correlationId),
      map((e) => ({ ok: true as const, response: e.response as TResult })),
    ),
    actor.on$<Record<string, unknown>>(failureChannel).pipe(
      filter((e) => e.correlationId === correlationId),
      map((e) => ({ ok: false as const, error: new BusRequestError(e.message as string) })),
    ),
  ).pipe(take(1), timeout(timeoutMs));

  const resultPromise = firstValueFrom(result$);

  await actor.emit(emitChannel, fullPayload);

  const result = await resultPromise;
  if (!result.ok) {
    throw result.error;
  }
  return result.response;
}
