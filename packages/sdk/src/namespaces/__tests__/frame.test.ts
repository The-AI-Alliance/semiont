/**
 * FrameNamespace — schema-layer flow tests.
 *
 * Frame is the eighth flow's surface. Two writes today:
 * `frame:add-entity-type` (vocabulary) and `frame:add-tag-schema`
 * (structural-analysis schemas — runtime-registered per KB; see
 * `.plans/TAG-SCHEMAS-GAP.md`). These tests pin the wire shape of
 * each write and the batch-emit behavior of `addEntityTypes`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { FrameNamespace } from '../frame';
import type { ITransport, TagSchema } from '@semiont/core';

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

  describe('addTagSchema()', () => {
    const TEST_SCHEMA: TagSchema = {
      id: 'test-schema',
      name: 'Test Schema',
      description: 'A schema for unit tests.',
      domain: 'test',
      tags: [
        { name: 'A', description: 'cat A', examples: ['ex1'] },
        { name: 'B', description: 'cat B', examples: ['ex2'] },
      ],
    };

    it('emits frame:add-tag-schema with the schema payload verbatim', async () => {
      await frame.addTagSchema(TEST_SCHEMA);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      // The wire shape is `{ schema: TagSchema }` — `_userId` is injected
      // by the gateway, never set by the SDK.
      expect(emitSpy).toHaveBeenCalledWith('frame:add-tag-schema', { schema: TEST_SCHEMA });
    });

    it('does not deep-copy or mutate the schema before emission', async () => {
      const before = JSON.stringify(TEST_SCHEMA);
      await frame.addTagSchema(TEST_SCHEMA);
      expect(JSON.stringify(TEST_SCHEMA)).toBe(before);
      // Same reference reaches the transport — the dispatcher (or wire
      // serialization) is responsible for any defensive copying.
      const [, payload] = emitSpy.mock.calls[0];
      expect((payload as { schema: TagSchema }).schema).toBe(TEST_SCHEMA);
    });
  });
});
