/**
 * SmeltProgress — backend-local fold of `smelt:settled` signals
 * (SMELTER-INDEX-SYNC P1, D1 = push barrier).
 *
 * The Smelter emits `smelt:settled` after deciding a resource's content:
 * `indexed` (embedded + upserted) or `skipped` (media gate, empty text) —
 * keyed by the checksum of the bytes it inspected, and NEVER on transient
 * failures (an error is not a decision; SMELTER-INDEX-SYNC A2). This unit
 * folds those signals per resource and exposes `whenSettled` — the
 * read-your-writes barrier: an event-driven await that resolves the moment
 * the vector projection has settled the exact content generation the caller
 * holds (the view's checksum), and rejects with `SmeltProgressTimeout` on
 * the bounded timeout so callers degrade observably (L4 breadcrumb).
 *
 * Deliberately transport-blind: it subscribes to the channel, not to the
 * Smelter. The signal arrives through the bus gateway from the standalone
 * worker; an in-process Smelter would ride the core EventBus and this unit
 * would not change (the WeaveProgress precedent).
 *
 * The fold is ephemeral by design — on backend restart it rebuilds lazily
 * from live signals. Barrier callers probe the vector store first
 * (SMELTER-INDEX-SYNC A3), so a cold fold only costs waits for resources
 * whose settlement genuinely hasn't been observed yet.
 */

import type { EventBus, StateUnit } from '@semiont/core';

/** Distinct rejection for a barrier that hit its bounded timeout. */
export class SmeltProgressTimeout extends Error {
  constructor(resourceId: string, contentChecksum: string, timeoutMs: number) {
    super(`smelt:settled not observed for ${resourceId} (checksum ${contentChecksum.slice(0, 12)}…) within ${timeoutMs}ms`);
    this.name = 'SmeltProgressTimeout';
  }
}

export type SmeltOutcome = 'indexed' | 'skipped';

export interface SmeltProgress extends StateUnit {
  /** The latest settlement seen for a resource, if any signal arrived. */
  settledAt(resourceId: string): { contentChecksum: string; outcome: SmeltOutcome } | undefined;
  /**
   * Resolve with the Smelter's decision once it has settled `resourceId` at
   * exactly `contentChecksum` — immediately if the fold already holds it.
   * Rejects with `SmeltProgressTimeout` after `timeoutMs`. After dispose it
   * resolves `'inert'`: shutdown must not throw through a gather in flight,
   * and callers treat inert as breadcrumb-less degrade.
   */
  whenSettled(resourceId: string, contentChecksum: string, timeoutMs: number): Promise<SmeltOutcome | 'inert'>;
}

/**
 * Entries older than this are evicted (lazily, at most one sweep per
 * SWEEP_INTERVAL_MS). Eviction is free correctness-wise: the barrier only
 * engages when the probe found no vectors, which cannot happen for a
 * settlement minutes old — and a missed immediate-resolve merely degrades
 * to the caller's bounded timeout. Same rationale as WeaveProgress.
 */
const SETTLED_TTL_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface Waiter {
  resourceId: string;
  contentChecksum: string;
  resolve: (outcome: SmeltOutcome | 'inert') => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createSmeltProgress(eventBus: EventBus): SmeltProgress {
  const settled = new Map<string, { contentChecksum: string; outcome: SmeltOutcome; at: number }>();
  const waiters = new Set<Waiter>();
  let disposed = false;
  let lastSweep = Date.now();

  const subscription = eventBus.get('smelt:settled').subscribe(({ resourceId, contentChecksum, outcome }) => {
    const now = Date.now();
    if (now - lastSweep >= SWEEP_INTERVAL_MS) {
      lastSweep = now;
      for (const [rid, entry] of settled) {
        if (now - entry.at >= SETTLED_TTL_MS) settled.delete(rid);
      }
    }

    // Latest settlement wins: signals leave the Smelter in per-resource lane
    // order, so the newest one reflects the current content generation.
    settled.set(resourceId, { contentChecksum, outcome, at: now });

    for (const waiter of waiters) {
      if (waiter.resourceId === resourceId && waiter.contentChecksum === contentChecksum) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(outcome);
      }
    }
  });

  return {
    settledAt: (resourceId) => {
      const entry = settled.get(resourceId);
      return entry ? { contentChecksum: entry.contentChecksum, outcome: entry.outcome } : undefined;
    },

    whenSettled: (resourceId, contentChecksum, timeoutMs) => {
      if (disposed) return Promise.resolve('inert');

      const current = settled.get(resourceId);
      if (current && current.contentChecksum === contentChecksum) {
        return Promise.resolve(current.outcome);
      }

      return new Promise<SmeltOutcome | 'inert'>((resolve, reject) => {
        const waiter: Waiter = {
          resourceId,
          contentChecksum,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new SmeltProgressTimeout(resourceId, contentChecksum, timeoutMs));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscription.unsubscribe();
      // Resolve pending waiters inert: shutdown must not throw through a
      // gather in flight — callers degrade without a breadcrumb.
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve('inert');
      }
      waiters.clear();
      settled.clear();
    },
  };
}
