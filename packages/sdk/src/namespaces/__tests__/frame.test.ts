/**
 * FrameNamespace — schema-layer flow tests.
 *
 * Frame is the eighth flow's surface. Two writes today:
 * `frame:add-entity-type` (vocabulary) and `frame:add-tag-schema`
 * (structural-analysis schemas — runtime-registered per KB; see
 * `.plans/TAG-SCHEMAS-GAP.md`).
 *
 * Writes are **confirmed**: each method goes through `busRequest`, emitting the
 * command (with a generated `correlationId`) and awaiting the backend's
 * correlation-keyed `*-add-ok` / `*-add-failed` reply. These tests pin the wire
 * shape of each write, the sequential batch behavior of `addEntityTypes`, and —
 * the reason the flow was made confirmed — that a backend failure **rejects**
 * rather than being silently dropped (.plans/bugs/BRIDGE-GAPS.md).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { FrameNamespace } from '../frame';
import type { ITransport, TagSchema } from '@semiont/core';

// command channel → its confirmed-write reply channels
const REPLY_FOR: Record<string, { ok: string; failed: string }> = {
  'frame:add-entity-type': { ok: 'frame:entity-type-add-ok', failed: 'frame:entity-type-add-failed' },
  'frame:add-tag-schema': { ok: 'frame:tag-schema-add-ok', failed: 'frame:tag-schema-add-failed' },
};

/**
 * Mock transport that auto-replies to each command on its reply channel,
 * echoing the `correlationId` busRequest generated — so a `busRequest` write
 * resolves (or, with `{ fail: true }`, rejects) deterministically.
 */
function createMockTransport(opts: { fail?: boolean } = {}): {
  transport: ITransport;
  emitSpy: ReturnType<typeof vi.fn>;
} {
  const subjects = new Map<string, Subject<unknown>>();
  const subjectFor = (ch: string) => {
    let s = subjects.get(ch);
    if (!s) { s = new Subject<unknown>(); subjects.set(ch, s); }
    return s;
  };

  const emitSpy = vi.fn(async (channel: string, payload: Record<string, unknown>) => {
    const reply = REPLY_FOR[channel];
    if (reply) {
      const correlationId = payload.correlationId;
      const target = opts.fail ? reply.failed : reply.ok;
      // The subscription is already live (busRequest subscribes before emitting),
      // so a synchronous push is delivered to the awaiting take(1).
      subjectFor(target).next(
        opts.fail ? { correlationId, message: 'backend add failed' } : { correlationId },
      );
    }
  });

  const transport = {
    emit: emitSpy,
    on: vi.fn(),
    stream: vi.fn((ch: string) => subjectFor(ch).asObservable()),
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

  it('addEntityType() emits frame:add-entity-type with the tag (+ a correlationId) and resolves on the ok reply', async () => {
    await frame.addEntityType('Person');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      'frame:add-entity-type',
      expect.objectContaining({ tag: 'Person', correlationId: expect.any(String) }),
    );
  });

  it('addEntityTypes() emits one event per type, preserving order', async () => {
    await frame.addEntityTypes(['Person', 'Organization', 'Location']);
    expect(emitSpy).toHaveBeenCalledTimes(3);
    expect(emitSpy).toHaveBeenNthCalledWith(1, 'frame:add-entity-type', expect.objectContaining({ tag: 'Person' }));
    expect(emitSpy).toHaveBeenNthCalledWith(2, 'frame:add-entity-type', expect.objectContaining({ tag: 'Organization' }));
    expect(emitSpy).toHaveBeenNthCalledWith(3, 'frame:add-entity-type', expect.objectContaining({ tag: 'Location' }));
  });

  it('addEntityTypes([]) is a no-op', async () => {
    await frame.addEntityTypes([]);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('REJECTS when the backend replies *-add-failed — a remote add-failure is not silently dropped', async () => {
    const { transport } = createMockTransport({ fail: true });
    const failing = new FrameNamespace(transport);
    await expect(failing.addEntityType('Person')).rejects.toThrow(/backend add failed/);
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
      // The wire shape is `{ schema: TagSchema }` (+ correlationId) — `_userId`
      // is injected by the gateway, never set by the SDK.
      expect(emitSpy).toHaveBeenCalledWith(
        'frame:add-tag-schema',
        expect.objectContaining({ schema: TEST_SCHEMA }),
      );
    });

    it('does not deep-copy or mutate the schema before emission', async () => {
      const before = JSON.stringify(TEST_SCHEMA);
      await frame.addTagSchema(TEST_SCHEMA);
      expect(JSON.stringify(TEST_SCHEMA)).toBe(before);
      // Same reference reaches the transport — busRequest spreads the payload
      // shallowly, so `schema` is not cloned.
      const [, payload] = emitSpy.mock.calls[0];
      expect((payload as { schema: TagSchema }).schema).toBe(TEST_SCHEMA);
    });
  });
});
