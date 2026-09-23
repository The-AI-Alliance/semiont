/**
 * The ONE composition of plane + ledger (SIGNAL-PLANE P3 GREEN). The route
 * (`routes/bus.ts`), the boot path (`index.ts`) and the multi-instance
 * harness all consume THIS — the harness hand-mirrored the wiring during P3
 * RED, and two copies of it is exactly the drift this module ends.
 *
 * What composing does, identically under both drivers:
 *
 *  - installs the ledger's STANDING tap: one client-mode subscription over
 *    every correlated channel, held for the life of the composition — a
 *    reply must be observed (answered + retained) even when its client is
 *    between connections, which is the whole recovery story;
 *  - subscribes the shared `LEDGER_ADDRESS`, where every replica's claim
 *    announcements arrive (`deliver`-published on `claim`), so the cluster's
 *    ledgers converge — the P3 cross-replica-claims resolution;
 *  - fronts the ledger's policy surface (`claim` — announcing on accept —
 *    `owner`, `lookupReply`, `mayDeliver`, `occupancy`) so no caller wires
 *    plane and ledger separately again.
 *
 * One composition per EventBus, cached: the route reaches it per-request,
 * boot pre-seeds it with the configured driver, tests get a lazy in-process
 * one. Passing a DIFFERENT plane for a bus that already composed is refused
 * loudly.
 *
 * This file never learns the correlation vocabulary: announcement shape and
 * parsing live in the ledger (the census-exempt file); frames pass through
 * here opaque.
 */
import type { EventBus } from '@semiont/core';
import { registerCorrelationRegistryProvider } from '@semiont/observability';
import { CORRELATED_CHANNELS } from './channels';
import { createInProcessSignalPlane } from './in-process';
import type { SignalPlane } from './interface';
import { CLAIM_CHANNEL, LEDGER_ADDRESS, createCorrelationRegistry, type CorrelationRegistry, type RetainedReply } from './ledger';

export interface SignalComposition {
  plane: SignalPlane;
  /** Emit-as-claim: local refusals are synchronous; an accepted claim is
   *  announced to every replica's ledger via the shared address. */
  claim(cid: string, clientId: string, principalDid: string | undefined): 'ok' | 'conflict' | 'at-capacity';
  owner(cid: string): { clientId: string; principalDid: string | undefined } | undefined;
  lookupReply(cid: string, clientId: string, principalDid: string | undefined): RetainedReply | undefined;
  /** Derived from the registry rather than restated: one declaration of the
   *  entitlement gate, and this file stays clear of the correlation
   *  vocabulary the P0.5 census bans on the plane side. */
  mayDeliver: CorrelationRegistry['mayDeliver'];
  occupancy(): { claims: number; retainedReplies: number };
  dispose(): void;
}

const byBus = new WeakMap<EventBus, SignalComposition>();

export function compositionFor(eventBus: EventBus, plane?: SignalPlane): SignalComposition {
  const existing = byBus.get(eventBus);
  if (existing) {
    if (plane !== undefined && plane !== existing.plane) {
      // Two planes for one bus is a split-brain ledger; whoever asked second
      // is mis-wired and must hear it now, not debug it later.
      throw new Error('signal composition: this EventBus is already composed with a different plane');
    }
    return existing;
  }

  const composedPlane = plane ?? createInProcessSignalPlane(eventBus);
  const ledger = createCorrelationRegistry();

  const tap = composedPlane.subscribeClient({
    address: LEDGER_ADDRESS,
    global: CORRELATED_CHANNELS,
    scoped: [],
    onFrame: (channel, payload, envelope) => {
      if (channel === CLAIM_CHANNEL) ledger.observeClaim(payload);
      else ledger.observe(channel, payload, envelope.meta);
    },
  });

  // Occupancy is the closest observable to the heap question two OOM
  // investigations keep asking: a retained browse result is 1-2 MB and up
  // to REPLY_RETENTION_MAX of them are held at once.
  registerCorrelationRegistryProvider(() => ledger.occupancy());

  const composition: SignalComposition = {
    plane: composedPlane,
    claim(cid, clientId, principalDid) {
      const outcome = ledger.claim(cid, clientId, principalDid);
      if (outcome === 'ok') {
        composedPlane.deliver(LEDGER_ADDRESS, CLAIM_CHANNEL, ledger.announcementFor(cid, clientId, principalDid));
      }
      return outcome;
    },
    owner: ledger.owner,
    lookupReply: ledger.lookupReply,
    mayDeliver: ledger.mayDeliver,
    occupancy: ledger.occupancy,
    dispose() {
      tap.close();
      ledger.dispose();
      byBus.delete(eventBus);
    },
  };
  byBus.set(eventBus, composition);
  return composition;
}
