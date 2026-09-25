/**
 * The ONE composition of plane + ledger (SIGNAL-PLANE P3 GREEN). The route
 * (`routes/bus.ts`), the boot path (`index.ts`) and the multi-instance
 * harness all consume THIS — the harness hand-mirrored the wiring during P3
 * RED, and two copies of it is exactly the drift this module ends.
 *
 * What composing does, identically under both drivers:
 *
 *  - opens the ledger over the plane's shared claims table (`ready` resolves
 *    once it is open and this replica holds what it already contained);
 *  - installs the ledger's STANDING tap: one client-mode subscription over
 *    every correlated channel, held for the life of the composition — a
 *    reply must be observed (answered + retained) even when its client is
 *    between connections, which is the whole recovery story;
 *  - fronts the ledger's policy surface (`claim`, `owner`, `lookupReply`,
 *    `gate`, `occupancy`) so no caller wires plane and ledger separately.
 *
 * One composition per EventBus, cached: the route reaches it per-request,
 * boot pre-seeds it with the configured driver, tests get a lazy in-process
 * one. Passing a DIFFERENT plane for a bus that already composed is refused
 * loudly.
 *
 * This file never learns the correlation vocabulary: frames pass through here
 * opaque, and the ledger (the census-exempt file) reads them.
 */
import { randomUUID } from 'crypto';
import type { EventBus } from '@semiont/core';
import { CORRELATED_CHANNELS } from './channels';
import { createInProcessSignalPlane } from './in-process';
import { toReplyAddress, type SignalPlane } from './interface';
import { createCorrelationRegistry, type CorrelationRegistry } from './ledger';

export interface SignalComposition {
  plane: SignalPlane;
  /** Resolves once the ledger's claims table is open and projected. */
  ready: Promise<void>;
  /** Emit-as-claim. Resolves once the claim is in the shared table — the
   *  caller dispatches the payload only after that. */
  claim: CorrelationRegistry['claim'];
  owner: CorrelationRegistry['owner'];
  lookupReply: CorrelationRegistry['lookupReply'];
  /** Derived from the registry rather than restated: one declaration of the
   *  entitlement gate, and this file stays clear of the correlation
   *  vocabulary the P0.5 census bans on the plane side. */
  gate: CorrelationRegistry['gate'];
  occupancy: CorrelationRegistry['occupancy'];
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
  const ledger = createCorrelationRegistry(composedPlane);

  // The tap holds an address because every client-mode subscription does.
  // Nothing is ever addressed to it, so it is unique rather than reserved: no
  // client name can collide with it.
  const tap = composedPlane.subscribeClient({
    address: toReplyAddress(`ledger-tap-${randomUUID()}`),
    global: CORRELATED_CHANNELS,
    scoped: [],
    onFrame: (channel, payload, envelope) => ledger.observe(channel, payload, envelope.meta),
  });

  const composition: SignalComposition = {
    plane: composedPlane,
    ready: ledger.ready,
    claim: ledger.claim,
    owner: ledger.owner,
    lookupReply: ledger.lookupReply,
    gate: ledger.gate,
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
