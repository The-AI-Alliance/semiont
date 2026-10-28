/**
 * subscribeChannel — a channel of no scope read by name, on the client's own
 * bus, which carries the client's in-process signals and the wire's events
 * alike. A channel of a resource's scope is read on the client's wire, for
 * one resource (`Bus.frames(channel, resourceId)`, in @semiont/core); read
 * here, it is refused, by the types and by the call.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTestClient } from '@semiont/sdk/testing';
import { subscribeChannel } from '../channel-subscription';

describe('a channel read by name', () => {
  it('reads a channel of no scope as it comes, and holds no scope for it', () => {
    const { client, transport } = createTestClient();
    const held = vi.spyOn(transport, 'subscribeToResource');
    const seen: string[] = [];

    const stop = subscribeChannel(client, 'beckon:hover', (hover) => seen.push(String(hover.annotationId)));
    client.bus.emit('beckon:hover', { annotationId: null });
    stop();
    client.bus.emit('beckon:hover', { annotationId: null });

    expect(seen).toEqual(['null']);
    expect(held).not.toHaveBeenCalled();
  });

  it('refuses a scoped channel: it is read on the wire, for its resource', () => {
    const { client, transport } = createTestClient();
    const held = vi.spyOn(transport, 'subscribeToResource');

    // @ts-expect-error — mark:archived is delivered on its resource's scope, so it is read on the wire for its resource
    expect(() => subscribeChannel(client, 'mark:archived', () => {})).toThrow(/mark:archived.*wire\.frames/);
    expect(held).not.toHaveBeenCalled();
  });
});
