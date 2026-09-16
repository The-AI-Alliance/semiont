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
    eventBus.on('mark:create-ok').subscribe(() => {});

    expect(eventBus.observedChannels()).toEqual(['mark:create-ok']);
  });

  it('does NOT report a channel that was only accessed', () => {
    // The load-bearing case. `get()` creates the subject, so the map has an
    // entry — but nobody is listening, and the parity gate must be able to
    // tell those apart.
    eventBus.on('mark:create-ok');

    expect(eventBus.observedChannels()).toEqual([]);
  });

  it('stops reporting a channel after its last subscriber leaves', () => {
    const sub = eventBus.on('mark:create-ok').subscribe(() => {});
    expect(eventBus.observedChannels()).toContain('mark:create-ok');

    sub.unsubscribe();

    // A DEAF actor — one that subscribed and went away — must not read as
    // present. The gate's failure message says "absent (or deaf)"; this is
    // the half of that which a boot-time check would otherwise miss.
    expect(eventBus.observedChannels()).toEqual([]);
  });

  it('keeps reporting while any subscriber remains', () => {
    const first = eventBus.on('mark:create-ok').subscribe(() => {});
    eventBus.on('mark:create-ok').subscribe(() => {});

    first.unsubscribe();

    expect(eventBus.observedChannels()).toEqual(['mark:create-ok']);
  });

  it('reports the CHANNEL a scoped subscription observes, without a scope prefix', () => {
    // Restated at BUS-CARRIES-FRAMES: this asserted `res-1:mark:create-ok`,
    // because scoping used to BE a channel-key prefix and scoped subjects
    // lived in the parent's map under that mangled name. Scope is now a field
    // on the frame, so there is one subject per channel and no mangled key to
    // report. The reason the gates use this accessor is unchanged — they ask
    // WHICH CHANNELS a root observes, and check membership against a roster
    // union (root-parity.test.ts, connect-record.test.ts); neither ever read
    // the scope half.
    eventBus.scope('res-1').on('mark:create-ok').subscribe(() => {});

    expect(eventBus.observedChannels()).toEqual(['mark:create-ok']);
  });

  it('a scoped and an unscoped subscription observe the SAME channel', () => {
    // The old shape could tell them apart because they were different
    // subjects. They are now one stream and two filtered views, so this
    // accessor cannot distinguish them — and should not pretend to. "Which
    // SCOPES are observed" is a different question; it deserves its own verb
    // if anything ever needs it, not a parsed string.
    eventBus.scope('res-1').on('mark:create-ok').subscribe(() => {});
    eventBus.on('mark:create-ok').subscribe(() => {});

    expect(eventBus.observedChannels()).toEqual(['mark:create-ok']);
  });

  it('reports every observed channel, scoped or not, exactly once', () => {
    eventBus.on('mark:create-ok').subscribe(() => {});
    eventBus.on('browse:resource-requested').subscribe(() => {});
    eventBus.scope('res-1').on('mark:create-ok').subscribe(() => {});
    eventBus.on('bind:body-updated'); // accessed only — must not appear

    expect(new Set(eventBus.observedChannels())).toEqual(
      new Set(['mark:create-ok', 'browse:resource-requested']),
    );
  });
});
