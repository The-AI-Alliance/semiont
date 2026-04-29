/**
 * FrameNamespace — schema-layer flow tests.
 *
 * Frame is the eighth flow's surface. MVP scope is small: entity-type
 * vocabulary writes on the `frame:add-entity-type` channel. These tests
 * pin the wire shape and the batch-emit behavior of `addEntityTypes`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { FrameNamespace } from '../frame';
import type { ITransport } from '@semiont/core';

function createMockTransport(): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn> } {
  const emitSpy = vi.fn().mockResolvedValue(undefined);
  const transport = {
    emit: emitSpy,
    on: vi.fn(),
    stream: vi.fn(),
    subscribeToResource: vi.fn().mockReturnValue(() => {}),
    bridgeInto: vi.fn(),
    state$: new BehaviorSubject<'connected'>('connected').asObservable() as never,
    dispose: vi.fn(),
  } as unknown as ITransport;
  return { transport, emitSpy };
}

describe('FrameNamespace', () => {
  let frame: FrameNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = createMockTransport();
    emitSpy = mock.emitSpy;
    frame = new FrameNamespace(mock.transport);
  });

  it('addEntityType() emits frame:add-entity-type with the tag', async () => {
    await frame.addEntityType('Person');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('frame:add-entity-type', { tag: 'Person' });
  });

  it('addEntityTypes() emits one event per type, preserving order', async () => {
    await frame.addEntityTypes(['Person', 'Organization', 'Location']);
    expect(emitSpy).toHaveBeenCalledTimes(3);
    expect(emitSpy).toHaveBeenNthCalledWith(1, 'frame:add-entity-type', { tag: 'Person' });
    expect(emitSpy).toHaveBeenNthCalledWith(2, 'frame:add-entity-type', { tag: 'Organization' });
    expect(emitSpy).toHaveBeenNthCalledWith(3, 'frame:add-entity-type', { tag: 'Location' });
  });

  it('addEntityTypes([]) is a no-op', async () => {
    await frame.addEntityTypes([]);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
