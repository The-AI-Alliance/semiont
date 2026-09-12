/**
 * The path from the EventStore to the wire keeps its types.
 *
 * `getDomainEvent` existed to avoid `as keyof EventMap` when subscribing with a
 * runtime `PersistedEventType` — but it got there by WIDENING the channel to
 * every bus channel and ERASING the event to `StoredEvent`, then casting back to
 * reconnect what it had just disconnected. The widening was never necessary:
 * every persisted type is already a channel, which is the invariant pinned below.
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '../event-bus';
import type { EventMap } from '../bus-protocol';
import type { PersistedEventType } from '../persisted-events';

describe('the domain-event path needs no casts', () => {
  it('every persisted event type is already a bus channel', () => {
    // The invariant that made the widening unnecessary. Green today, and kept:
    // it fails the day a persisted type is not a channel, which is the only way
    // `as keyof EventMap` could become necessary again.
    const holds: PersistedEventType extends keyof EventMap ? true : false = true;
    expect(holds).toBe(true);
  });

  it('has no getDomainEvent to funnel casts through', () => {
    const bus = new EventBus();
    // @ts-expect-error — deleted; `get` is already channel-typed
    expect(typeof bus.getDomainEvent).toBe('undefined');
  });

  it('get() on a persisted type yields that channel, not an erased one', () => {
    // What replaces it: `get` carries the channel's own type through, so a
    // subscriber sees `EventMap[K]` rather than a widened `StoredEvent`.
    const bus = new EventBus();
    const seen: EventMap['mark:added'][] = [];
    bus.get('mark:added').subscribe((e) => seen.push(e));
    expect(seen).toEqual([]);
  });
});
