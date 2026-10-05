/**
 * The fact pump: every persisted event the Archivist appends is republished
 * onto the gateway bus, once global and once resource-scoped, so projectors
 * and scoped clients see it live.
 *
 * A unit of its own, apart from `archivist-main`'s composition root, so it can
 * be tested and measured: its backlog is the leading suspect for
 * load-correlated heap growth, and an Archivist that reaches Node's default
 * heap ceiling dies and leaves every browse request waiting with no reply.
 *
 * **Ordering is load-bearing.** Events drain one at a time, in
 * arrival order, because a projector applying `mark:added` before the
 * `yield:created` it belongs to would materialize a view from an event whose
 * subject does not exist yet. Only the two emits WITHIN one event run
 * together — they are independent by construction, and serialising them
 * would double the drain time per event for nothing.
 *
 * **The backlog is deliberately unbounded.** Bounding it means
 * choosing what to discard on overflow, and a discarded fact leaves that
 * projector stale until its NEXT RESTART — catch-up is a startup pass in both
 * `smelter-main` (`reconcile()`) and `weaver-main`, not a continuous repair.
 * A projection silently days out of date is the same class of defect as a
 * silent 202 for a request nobody will answer. `depth()` makes the backlog
 * measurable; a bound follows from that number, not the other way round.
 */

import { from, concatMap, tap, type Observable, type Subscription } from 'rxjs';
import type { EventMap, Logger, PersistedEventType, ResourceId } from '@semiont/core';
import { errField } from '@semiont/core';

export interface FactPumpDeps {
  /** The wire. Narrowed to the one call the pump makes — never the transport. */
  emit: <K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    resourceScope?: ResourceId,
  ) => Promise<unknown>;
  logger: Logger;
}

export interface FactPump {
  /**
   * Facts accepted from the local bus but not yet published — how far behind
   * the wire the pump is running. Zero at rest; a number that climbs and does
   * not return is the pump outrunning its transport.
   */
  depth(): number;
  unsubscribe(): void;
}

/** One fact, on its own channel — what `archivist-main`'s merge already yields. */
type Fact = EventMap[PersistedEventType];

export function createFactPump(facts$: Observable<Fact>, deps: FactPumpDeps): FactPump {
  let depth = 0;

  const publish = async (event: Fact): Promise<void> => {
    try {
      // Concurrent: the global and scoped emits are independent, and the
      // event is the same object in both. Ordering between EVENTS is the
      // concatMap below; this parallelism does not touch it.
      await Promise.all([
        deps.emit(event.type, event),
        ...(event.resourceId ? [deps.emit(event.type, event, event.resourceId)] : []),
      ]);
    } catch (error) {
      // Never rethrow: one unreachable gateway must not tear down the pump
      // for every future fact. The projector heals on its next catch-up —
      // true, but that is a STARTUP pass, so this line is a real degradation
      // and not merely noise.
      deps.logger.error('Fact publish failed — projectors will heal on their next catch-up', {
        type: event.type,
        resourceId: event.resourceId,
        sequenceNumber: event.metadata?.sequenceNumber,
        error: errField(error),
      });
    }
  };

  const subscription: Subscription = facts$
    .pipe(
      tap(() => { depth += 1; }),
      concatMap((event) => from(publish(event).finally(() => { depth -= 1; }))),
    )
    .subscribe();

  return {
    depth: () => depth,
    unsubscribe: () => subscription.unsubscribe(),
  };
}
