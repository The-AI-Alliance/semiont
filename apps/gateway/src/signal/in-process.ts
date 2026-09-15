/**
 * The in-process Signal Plane driver — today's hub mechanics, extracted
 * (SIGNAL-PLANE P0.4), behavior-identical: the fabric is the process itself,
 * one shared `EventBus`, RxJS fan-out. NOT scheduled for retirement (D7): a
 * local stack that configures no broker runs this forever.
 *
 * This file moves frames. It never inspects a payload, never refuses a
 * delivery, and never learns the correlation vocabulary — the conformance
 * suite's census makes that mechanical. Entitlement, validation, auth and
 * the ledger live above the seam, in the gateway.
 */
import type { EventBus, EventMap } from '@semiont/core';
import type { Subscription } from 'rxjs';
import type {
  ClientSubscriptionSpec,
  IngestReceipt,
  OnFrame,
  PlaneSubscription,
  SignalPlane,
} from './interface';
import { resolveSignalPlaneOptions, type SignalPlaneOptions } from './options';

interface HandlerGroup {
  members: OnFrame[];
  rr: number;
  /** One underlying tap per channel, shared by the group (members of one
   *  group share the group's channel union — the group is the consumer). */
  taps: Map<string, Subscription>;
}

export function createInProcessSignalPlane(
  eventBus: EventBus,
  opts?: SignalPlaneOptions,
): SignalPlane {
  const options = resolveSignalPlaneOptions(opts);
  const openSubs = new Set<Subscription>();
  const groups = new Map<string, HandlerGroup>();
  /** Addressed delivery in-process: address → the onFrames subscribed under
   *  it (an inbox subject under NATS; a plain map here). */
  const inboxes = new Map<string, Set<OnFrame>>();

  const track = (s: Subscription): Subscription => {
    openSubs.add(s);
    return s;
  };

  return {
    ingest(channel, payload, scope): IngestReceipt {
      const bus = scope ? eventBus.scope(scope) : eventBus;
      const subject = bus.get(channel as keyof EventMap);
      const observers = subject.observers.length;
      subject.next(payload as never);
      return { observers };
    },

    subscribeClient(spec: ClientSubscriptionSpec): PlaneSubscription {
      // The same runaway guard the route enforces at parse — defense in
      // depth at the seam, so a second caller cannot bypass it.
      if (spec.scoped.length > options.maxScopes) {
        throw new Error(
          `signal plane: ${spec.scoped.length} scopes exceeds the per-subscription cap of ${options.maxScopes}`,
        );
      }
      const subs: Subscription[] = [];
      for (const channel of spec.global) {
        subs.push(
          track(
            eventBus.get(channel as keyof EventMap).subscribe((payload) => {
              spec.onFrame(channel, payload, undefined);
            }),
          ),
        );
      }
      for (const entry of spec.scoped) {
        const scopedBus = eventBus.scope(entry.scope);
        for (const channel of entry.channels) {
          subs.push(
            track(
              scopedBus.get(channel as keyof EventMap).subscribe((payload) => {
                spec.onFrame(channel, payload, entry.scope);
              }),
            ),
          );
        }
      }
      let box = inboxes.get(spec.address);
      if (!box) {
        box = new Set();
        inboxes.set(spec.address, box);
      }
      box.add(spec.onFrame);
      return {
        close() {
          for (const s of subs) {
            s.unsubscribe();
            openSubs.delete(s);
          }
          const held = inboxes.get(spec.address);
          if (held) {
            held.delete(spec.onFrame);
            if (held.size === 0) inboxes.delete(spec.address);
          }
        },
      };
    },

    deliver(address, channel, payload): void {
      const box = inboxes.get(address);
      if (!box) return;
      for (const onFrame of box) onFrame(channel, payload, undefined);
    },

    subscribeHandlers(groupName, channels, onFrame): PlaneSubscription {
      let group = groups.get(groupName);
      if (!group) {
        group = { members: [], rr: 0, taps: new Map() };
        groups.set(groupName, group);
      }
      const g = group;
      g.members.push(onFrame);
      for (const channel of channels) {
        if (!g.taps.has(channel)) {
          g.taps.set(
            channel,
            track(
              eventBus.get(channel as keyof EventMap).subscribe((payload) => {
                // Group semantics: each frame reaches AT MOST ONE member,
                // never two (round-robin here; a queue group under NATS).
                if (g.members.length === 0) return;
                const target = g.members[g.rr++ % g.members.length]!;
                target(channel, payload, undefined);
              }),
            ),
          );
        }
      }
      return {
        close() {
          const at = g.members.indexOf(onFrame);
          if (at >= 0) g.members.splice(at, 1);
          if (g.members.length === 0) {
            for (const tap of g.taps.values()) {
              tap.unsubscribe();
              openSubs.delete(tap);
            }
            g.taps.clear();
            groups.delete(groupName);
          }
        },
      };
    },

    dispose() {
      for (const s of openSubs) s.unsubscribe();
      openSubs.clear();
      groups.clear();
      inboxes.clear();
    },
  };
}
