import { firstValueFrom, race, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { EventBus, type EmittableChannel, type EventMap, type EventName } from '@semiont/core';

/**
 * Await an in-process command's domain reply, with a timeout. Emits `command`,
 * then races the ok channel against the failure channel and a timer: resolves
 * when `okChannel` fires first, throws the failure's `message` when
 * `failedChannel` fires first, throws on timeout.
 *
 * This is the importers' UN-correlated request/reply. It is safe only because
 * replay/import drives commands strictly sequentially (one event awaited at a
 * time), so the missing correlationId can't cross-match. It is deliberately NOT
 * `busRequest`: these emit the lower-level `mark:*` commands, which sit outside
 * the busRequest registry (see .plans/BUS-OPERATIONS-REGISTRY.md). Factored out
 * of four identical `race()` blocks in replay.ts and linked-data-importer.ts.
 */
export function awaitReply<C extends EmittableChannel>(
  eventBus: EventBus,
  command: C,
  payload: EventMap[C],
  okChannel: EventName,
  failedChannel: EventName,
  timeoutMs: number,
): Promise<void> {
  const result$ = race(
    eventBus.get(okChannel).pipe(map(() => undefined)),
    eventBus.get(failedChannel).pipe(
      map((e) => {
        throw new Error((e as { message?: string }).message ?? `${command} failed`);
      }),
    ),
    timer(timeoutMs).pipe(
      map(() => {
        throw new Error(`Timeout waiting for ${okChannel}`);
      }),
    ),
  );
  eventBus.get(command).next(payload);
  return firstValueFrom(result$);
}
