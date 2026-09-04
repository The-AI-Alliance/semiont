/**
 * Adapt the string-typed `WorkerBus` to the `BusRequestPrimitive` that
 * `busRequest` consumes, so every worker-side request/reply rides the same
 * path as the SDK instead of a hand-rolled copy of it.
 *
 * Its own module rather than a shared export from `job-claim-adapter`: two
 * unrelated callers need it (job claiming and the P6 durability commit), and
 * `worker-process.test.ts` mocks the claim adapter wholesale — importing a
 * pure helper through a module that tests replace makes the helper vanish
 * under the mock.
 */
import type { BusRequestPrimitive, EventMap } from '@semiont/core';
import type { WorkerBus } from '@semiont/sdk';
import type { Observable } from 'rxjs';

export function workerBusAsPrimitive(bus: WorkerBus): BusRequestPrimitive {
  return {
    emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<number> {
      return bus.emit(channel as string, payload as Record<string, unknown>);
    },
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
      return bus.on$<EventMap[K]>(channel as string);
    },
    // Pass the real connection state through: a worker's first `job:claim`
    // fires right after connect — exactly the attach-window emit the gate
    // exists for (.plans/BUS-ATTACH-GATE.md).
    state$: bus.state$,
    // Pass the subscription probe through so a request against a transport
    // whose narrowed channel set omits the replies fails fast
    // (`bus.unsubscribed`) instead of timing out.
    ...(bus.isSubscribed ? { isSubscribed: (channel: string) => bus.isSubscribed!(channel) } : {}),
  };
}
