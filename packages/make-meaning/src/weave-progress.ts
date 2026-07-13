/**
 * WeaveProgress — backend-local fold of `weave:applied` signals
 * (GRAPH-PROJECTION-SYNC P2, D2 = push).
 *
 * The Weaver emits `weave:applied` after applying an event (or a batch's
 * last event) for a resource. This unit folds those signals into a
 * per-resource applied-sequence map and exposes `whenApplied` — the
 * applied-offset barrier: an event-driven await that resolves the moment
 * the graph projection reaches parity with a known sequence (typically the
 * view's `lastSequence`), and rejects with `WeaveProgressTimeout` on the
 * bounded timeout so callers can fall back to the bounded-poll floor.
 *
 * Deliberately transport-blind: it subscribes to the channel, not to the
 * Weaver. In-process the signal rides the core EventBus; after
 * WEAVER-ISOLATION the same channel arrives through the bus gateway and
 * this unit does not change.
 *
 * The map is ephemeral by design — on backend restart it rebuilds lazily
 * from live signals. That loses nothing: a waiter only ever waits for an
 * apply that has not happened yet, and those signals are still to come.
 */

import type { EventBus, StateUnit } from '@semiont/core';

/** Distinct rejection for a barrier that hit its bounded timeout. */
export class WeaveProgressTimeout extends Error {
  constructor(resourceId: string, sequenceNumber: number, timeoutMs: number) {
    super(`weave:applied parity not reached for ${resourceId} (seq ${sequenceNumber}) within ${timeoutMs}ms`);
    this.name = 'WeaveProgressTimeout';
  }
}

interface Waiter {
  resourceId: string;
  sequenceNumber: number;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WeaveProgress extends StateUnit {
  /** Highest applied sequence seen for a resource, if any signal arrived. */
  appliedUpTo(resourceId: string): number | undefined;
  /**
   * Resolve when the Weaver has applied at least `sequenceNumber` for
   * `resourceId` — immediately if the fold already covers it. Rejects with
   * `WeaveProgressTimeout` after `timeoutMs`. After dispose it resolves
   * immediately (inert): barrier callers degrade to their poll floor.
   */
  whenApplied(resourceId: string, sequenceNumber: number, timeoutMs: number): Promise<void>;
}

/**
 * Entries older than this are evicted (lazily, at most one sweep per
 * SWEEP_INTERVAL_MS). Eviction is free correctness-wise: the barrier only
 * engages when a graph read came back null, which cannot happen for an
 * apply minutes old — and a missed immediate-resolve merely degrades to
 * the caller's poll floor. Without it the map grows with every resource
 * ever signaled (#845 scalability).
 */
const APPLIED_TTL_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

export function createWeaveProgress(eventBus: EventBus): WeaveProgress {
  const applied = new Map<string, { seq: number; at: number }>();
  const waiters = new Set<Waiter>();
  let disposed = false;
  let lastSweep = Date.now();

  const subscription = eventBus.get('weave:applied').subscribe(({ resourceId, sequenceNumber }) => {
    const now = Date.now();
    if (now - lastSweep >= SWEEP_INTERVAL_MS) {
      lastSweep = now;
      for (const [rid, entry] of applied) {
        if (now - entry.at >= APPLIED_TTL_MS) applied.delete(rid);
      }
    }

    // Monotonic fold: a stale lower signal (e.g. redelivery) never
    // regresses the high-water mark.
    const current = applied.get(resourceId);
    if (current !== undefined && current.seq >= sequenceNumber) return;
    applied.set(resourceId, { seq: sequenceNumber, at: now });

    for (const waiter of waiters) {
      if (waiter.resourceId === resourceId && sequenceNumber >= waiter.sequenceNumber) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });

  return {
    appliedUpTo: (resourceId) => applied.get(resourceId)?.seq,

    whenApplied: (resourceId, sequenceNumber, timeoutMs) => {
      if (disposed) return Promise.resolve();

      const current = applied.get(resourceId)?.seq;
      if (current !== undefined && current >= sequenceNumber) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resourceId,
          sequenceNumber,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new WeaveProgressTimeout(resourceId, sequenceNumber, timeoutMs));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscription.unsubscribe();
      // Release pending waiters by resolving: shutdown must not throw through
      // a gather in flight — the caller re-reads and lands on its poll floor.
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      waiters.clear();
      applied.clear();
    },
  };
}
