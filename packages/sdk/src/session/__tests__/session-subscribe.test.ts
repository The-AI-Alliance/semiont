/**
 * SemiontSession.subscribe — a channel read by name.
 *
 * A channel of a resource's scope reaches only a connection that holds that
 * scope, so its subscription names the resource: it holds the scope for as
 * long as it lives, and is given that resource's events and no other's.
 * Subscribing to one with no resource is refused, by the types and by the
 * call.
 */

import { describe, it, expect, vi } from 'vitest';
import { resourceId, userId } from '@semiont/core';
import type { EventMetadata, EventOfType, ResourceId, StoredEvent } from '@semiont/core';
import { createTestSession } from '../../testing';

const RID = resourceId('res-1');
const OTHER = resourceId('res-2');
const META: EventMetadata = { sequenceNumber: 1 };

function archived(of: ResourceId): StoredEvent<EventOfType<'mark:archived'>> {
  return {
    id: `evt-${of}`,
    type: 'mark:archived',
    resourceId: of,
    userId: userId('did:web:example.org:users:alice'),
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: {},
    metadata: META,
  };
}

describe('SemiontSession.subscribe', () => {
  it('reads a channel of no scope as it comes, and holds no scope for it', () => {
    const { session, client, transport } = createTestSession();
    const held = vi.spyOn(transport, 'subscribeToResource');
    const seen: string[] = [];

    const stop = session.subscribe('beckon:hover', (hover) => seen.push(String(hover.annotationId)));
    client.bus.emit('beckon:hover', { annotationId: null });
    stop();
    client.bus.emit('beckon:hover', { annotationId: null });

    expect(seen).toEqual(['null']);
    expect(held).not.toHaveBeenCalled();
  });

  it("holds the resource's scope for as long as a scoped channel's subscription lives, and gives it that resource's events only", () => {
    const { session, client, transport } = createTestSession();
    const leave = vi.fn();
    const held = vi.spyOn(transport, 'subscribeToResource').mockReturnValue(leave);
    const seen: string[] = [];

    const stop = session.subscribe('mark:archived', RID, (event) => seen.push(event.id));
    expect(held).toHaveBeenCalledExactlyOnceWith(RID);

    // What a stream delivers for the scopes it holds reaches the client's bus
    // on one channel: another resource's events are there too.
    client.bus.emit('mark:archived', archived(RID));
    client.bus.emit('mark:archived', archived(OTHER));
    expect(seen).toEqual(['evt-res-1']);
    expect(leave).not.toHaveBeenCalled();

    stop();
    expect(leave).toHaveBeenCalledOnce();
    client.bus.emit('mark:archived', archived(RID));
    expect(seen).toEqual(['evt-res-1']);
  });

  it('refuses a scoped channel named with no resource: such a subscription would hear nothing', () => {
    const { session, transport } = createTestSession();
    const held = vi.spyOn(transport, 'subscribeToResource');

    // @ts-expect-error — mark:archived is delivered on its resource's scope, so its subscription names the resource
    expect(() => session.subscribe('mark:archived', () => {})).toThrow(/mark:archived.*resource/);
    expect(held).not.toHaveBeenCalled();
  });

  it('refuses a channel of no scope named with a resource: it would hold a scope and hear nothing', () => {
    const { session, transport } = createTestSession();
    const held = vi.spyOn(transport, 'subscribeToResource');

    // @ts-expect-error — beckon:hover is no resource's channel
    expect(() => session.subscribe('beckon:hover', RID, () => {})).toThrow(/beckon:hover is no resource's channel/);
    expect(held).not.toHaveBeenCalled();
  });
});
