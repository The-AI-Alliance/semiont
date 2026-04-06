/**
 * Shared batch utilities for event-processing actors (GraphDBConsumer, Smelter).
 *
 * Both actors use the same pattern: burst-buffered events arrive as a batch,
 * get partitioned into consecutive same-type runs, and each run is processed
 * with a type-specific batch handler.
 */

import type { StoredEvent } from '@semiont/core';

/**
 * Partition a batch of events into runs of consecutive same-type events.
 * e.g. [A, A, B, B, B, A] → [[A, A], [B, B, B], [A]]
 */
export function partitionByType(events: StoredEvent[]): StoredEvent[][] {
  const runs: StoredEvent[][] = [];
  let currentRun: StoredEvent[] = [];

  for (const event of events) {
    if (currentRun.length > 0 && currentRun[0].event.type !== event.event.type) {
      runs.push(currentRun);
      currentRun = [];
    }
    currentRun.push(event);
  }
  if (currentRun.length > 0) runs.push(currentRun);

  return runs;
}
