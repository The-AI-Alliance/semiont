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
  PlaneEnvelope,
  PlaneSubscription,
  SharedTable,
  SignalPlane,
} from './interface';
import { resolveSignalPlaneOptions, type SignalPlaneOptions } from './options';

/** The frame's envelope, as the seam's `PlaneEnvelope`.
 *
 *  `scope` is the one field this fabric INTERPRETS; everything else is
 *  ferried verbatim into `meta`. Written that way round on purpose — the
 *  driver must not learn the vocabulary of what it carries (the P0.5
 *  census), so nothing here names a key of the metadata. */
function envelopeOf(frame: { scope?: string }): PlaneEnvelope {
  const { payload: _payload, scope, ...rest } = frame as { payload: unknown; scope?: string };
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) if (typeof v === 'string') meta[k] = v;
  // Absent, not empty: a frame that carried no metadata must present the same
  // envelope here as it does across a broker, or the conformance suite would
  // be comparing fabrics that agree on delivery and differ on shape.
  return Object.keys(meta).length === 0 ? { scope } : { scope, meta };
}

interface HandlerGroup {
  members: OnFrame[];
  rr: number;
  /** One underlying tap per channel, shared by the group (members of one
   *  group share the group's channel union — the group is the consumer). */
  taps: Map<string, Subscription>;
}

/**
 * One shared table, in-process: the fabric is the process, so every handle on
 * a name is this one map. Insertion-ordered, so expired entries are always a
 * prefix and a sweep is a walk that stops at the first live one — without it
 * a process with no broker would hold every entry it was ever handed.
 */
interface MemoryTable {
  ttlMs: number;
  entries: Map<string, { value: string; at: number }>;
  watchers: Set<(key: string, value: string) => void>;
}

function handleOn(table: MemoryTable): SharedTable {
  const sweep = () => {
    const cutoff = Date.now() - table.ttlMs;
    for (const [key, entry] of table.entries) {
      if (entry.at > cutoff) break;
      table.entries.delete(key);
    }
  };
  return {
    async create(key, value) {
      sweep();
      if (table.entries.has(key)) return false;
      table.entries.set(key, { value, at: Date.now() });
      for (const watcher of table.watchers) watcher(key, value);
      return true;
    },
    async read(key) {
      sweep();
      return table.entries.get(key)?.value;
    },
    async watch(onEntry) {
      sweep();
      for (const [key, entry] of table.entries) onEntry(key, entry.value);
      table.watchers.add(onEntry);
      return { close: () => table.watchers.delete(onEntry) };
    },
  };
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
  const tables = new Map<string, MemoryTable>();

  const track = (s: Subscription): Subscription => {
    openSubs.add(s);
    return s;
  };

  return {
    ingest(channel, payload, envelope): IngestReceipt {
      const bus = envelope?.scope ? eventBus.scope(envelope.scope) : eventBus;
      // The whole envelope rides through: the in-process fabric is the bus,
      // and a handler must read the same envelope here as over a broker.
      // Spread, not destructured: the driver hands the ferried metadata to the
      // bus without naming a single key of it. Reading one would make this
      // driver a reader of gateway policy, which the P0.5 census forbids.
      const observers = bus.emit(channel as keyof EventMap, payload as never, {
        ...envelope?.meta,
      });
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
            eventBus.frames(channel as keyof EventMap).subscribe((frame) => {
              spec.onFrame(channel, frame.payload, envelopeOf(frame));
            }),
          ),
        );
      }
      for (const entry of spec.scoped) {
        const scopedBus = eventBus.scope(entry.scope);
        for (const channel of entry.channels) {
          subs.push(
            track(
              scopedBus.frames(channel as keyof EventMap).subscribe((frame) => {
                spec.onFrame(channel, frame.payload, envelopeOf(frame));
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
      for (const onFrame of box) onFrame(channel, payload, {});
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
              eventBus.frames(channel as keyof EventMap).subscribe((frame) => {
                // Group semantics: each frame reaches AT MOST ONE member,
                // never two (round-robin here; a queue group under NATS).
                if (g.members.length === 0) return;
                const target = g.members[g.rr++ % g.members.length]!;
                target(channel, frame.payload, envelopeOf(frame));
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

    async flush() {
      // The honest answer for this fabric, not a stub: delivery here is
      // synchronous `Subject.next`, so by the time any call returns there is
      // nothing in flight and every subscription is already live. A driver
      // that answered by omission would be the optional-member mistake in
      // another costume.
    },

    async table(name, ttlMs) {
      let table = tables.get(name);
      if (!table) {
        table = { ttlMs, entries: new Map(), watchers: new Set() };
        tables.set(name, table);
      } else if (table.ttlMs !== ttlMs) {
        throw new Error(`signal plane: table "${name}" is already open with a TTL of ${table.ttlMs} ms, not ${ttlMs}`);
      }
      return handleOn(table);
    },

    dispose() {
      for (const s of openSubs) s.unsubscribe();
      openSubs.clear();
      groups.clear();
      inboxes.clear();
      tables.clear();
    },
  };
}
