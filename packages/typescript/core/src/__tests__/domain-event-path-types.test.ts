/**
 * The path from the EventStore to the wire keeps its types.
 *
 * Subscribing with a runtime `PersistedEventType` needs no `as keyof EventMap`,
 * and no helper to hide one: a `getDomainEvent` that WIDENS the channel to
 * every bus channel and ERASES the event to `StoredEvent` only casts back to
 * reconnect what it disconnected. Every persisted type is already a channel,
 * which is the invariant pinned below.
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '../event-bus';
import type { EventMap } from '../bus-protocol';
import type { PersistedEventType } from '../persisted-events';

describe('the domain-event path needs no casts', () => {
  it('every persisted event type is already a bus channel', () => {
    // The invariant that makes widening unnecessary: it fails the day a
    // persisted type is not a channel, which is the only way
    // `as keyof EventMap` could become necessary.
    const holds: PersistedEventType extends keyof EventMap ? true : false = true;
    expect(holds).toBe(true);
  });

  it('has no getDomainEvent to funnel casts through', () => {
    const bus = new EventBus();
    // @ts-expect-error — EventBus has no getDomainEvent; `on` is already channel-typed
    expect(typeof bus.getDomainEvent).toBe('undefined');
  });

  it('on() on a persisted type yields that channel, not an erased one', () => {
    // `on` carries the channel's own type through, so a subscriber sees
    // `EventMap[K]` rather than a widened `StoredEvent`.
    const bus = new EventBus();
    const seen: EventMap['mark:added'][] = [];
    bus.on('mark:added').subscribe((e) => seen.push(e));
    expect(seen).toEqual([]);
  });
});
