/**
 * `EventBus.observedChannels()` — the introspection the composition-parity
 * gate stands on (`root-parity.test.ts`).
 *
 * That gate asserts the in-process root subscribes every channel the extracted
 * services do. Its whole value rests on one property of this accessor: mere
 * ACCESS must not count. `get()` creates subjects lazily, so if a lazily-made
 * subject with no subscriber were reported as observed, the gate would pass
 * for a root that touched every channel and listened to none — precisely the
 * regression it exists to catch.
 *
 * These are here rather than beside the gate because the gate needs a full
 * boot to run: it can only ever exercise this accessor incidentally, and never
 * the negative cases at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../event-bus';

describe('EventBus.observedChannels', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('is empty on a fresh bus', () => {
    expect(eventBus.observedChannels()).toEqual([]);
  });

  it('reports a channel once something subscribes to it', () => {
    eventBus.get('mark:create-ok').subscribe(() => {});

    expect(eventBus.observedChannels()).toEqual(['mark:create-ok']);
  });

  it('does NOT report a channel that was only accessed', () => {
    // The load-bearing case. `get()` creates the subject, so the map has an
    // entry — but nobody is listening, and the parity gate must be able to
    // tell those apart.
    eventBus.get('mark:create-ok');

    expect(eventBus.observedChannels()).toEqual([]);
  });

  it('stops reporting a channel after its last subscriber leaves', () => {
    const sub = eventBus.get('mark:create-ok').subscribe(() => {});
    expect(eventBus.observedChannels()).toContain('mark:create-ok');

    sub.unsubscribe();

    // A DEAF actor — one that subscribed and went away — must not read as
    // present. The gate's failure message says "absent (or deaf)"; this is
    // the half of that which a boot-time check would otherwise miss.
    expect(eventBus.observedChannels()).toEqual([]);
  });

  it('keeps reporting while any subscriber remains', () => {
    const first = eventBus.get('mark:create-ok').subscribe(() => {});
    eventBus.get('mark:create-ok').subscribe(() => {});

    first.unsubscribe();

    expect(eventBus.observedChannels()).toEqual(['mark:create-ok']);
  });

  it('reports scoped channels under their namespaced key', () => {
    eventBus.scope('res-1').get('mark:create-ok').subscribe(() => {});

    // Scoped subjects live in the PARENT's map under `<scope>:<channel>`, so
    // the parent sees them — which is what lets the gate introspect a root
    // whose actors subscribe per-resource.
    expect(eventBus.observedChannels()).toEqual(['res-1:mark:create-ok']);
  });

  it('distinguishes a scoped subscription from the unscoped channel', () => {
    eventBus.scope('res-1').get('mark:create-ok').subscribe(() => {});

    const observed = eventBus.observedChannels();
    expect(observed).toContain('res-1:mark:create-ok');
    expect(observed).not.toContain('mark:create-ok');
  });

  it('reports every observed channel, across scopes', () => {
    eventBus.get('mark:create-ok').subscribe(() => {});
    eventBus.get('browse:resource-requested').subscribe(() => {});
    eventBus.scope('res-1').get('mark:create-ok').subscribe(() => {});
    eventBus.get('bind:body-updated'); // accessed only — must not appear

    expect(new Set(eventBus.observedChannels())).toEqual(
      new Set(['mark:create-ok', 'browse:resource-requested', 'res-1:mark:create-ok']),
    );
  });
});
