/**
 * The fact pump: every persisted event the Archivist appends is republished
 * onto the gateway bus so projectors see it live (EXTRACT-ARCHIVIST D5).
 *
 * Extracted from `archivist-main`'s composition root by ARCHIVIST-STAYS-UP P5.
 * It was three inline statements there, which meant the one component whose
 * backlog is the leading suspect for load-correlated heap growth
 * (`bugs/absent-archivist-wedges-browse.md`) could not be tested or measured
 * at all.
 *
 * **Ordering is load-bearing and preserved.** Events drain one at a time, in
 * arrival order, because a projector applying `mark:added` before the
 * `yield:created` it belongs to would materialize a view from an event whose
 * subject does not exist yet. Only the two emits WITHIN one event run
 * together — they are independent by construction, and serialising them
 * doubled the drain time per event for nothing.
 *
 * **The backlog is deliberately unbounded, for now.** Bounding it means
 * choosing what to discard on overflow, and a discarded fact leaves that
 * projector stale until its NEXT RESTART — catch-up is a startup pass in both
 * `smelter-main` (`reconcile()`) and `weaver-main`, not a continuous repair.
 * A projection silently days out of date is the same class of defect as the
 * silent 202 this plan exists to remove. So: measure first. `depth()` is what
 * makes that possible; the policy follows the number, not the other way round.
 */

import { from, concatMap, tap, type Observable, type Subscription } from 'rxjs';
import type { EventMap, Logger, ResourceId, StoredEvent } from '@semiont/core';
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

export function createFactPump(facts$: Observable<StoredEvent>, deps: FactPumpDeps): FactPump {
  let depth = 0;

  const publish = async (event: StoredEvent): Promise<void> => {
    try {
      const type = event.type as keyof EventMap;
      // Concurrent: the global and scoped emits are independent, and the
      // event is the same object in both. Ordering between EVENTS is the
      // concatMap below; this parallelism does not touch it.
      await Promise.all([
        deps.emit(type, event as never),
        ...(event.resourceId ? [deps.emit(type, event as never, event.resourceId)] : []),
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
