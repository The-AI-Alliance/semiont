/**
 * `ResourceOperations` — the one statement of how a resource write maps onto
 * its channel's payload (GATEWAY-DEPENDS-ON-CORE-ONLY P1).
 *
 * Imported from the package index, not the module, because the claim under
 * test is that core EXPORTS it: the gateway and make-meaning both derive from
 * this one mapping rather than each restating the `yield:create`,
 * `yield:clone-persist` and `yield:clone-create` payload shapes.
 *
 * The Stower is faked as a responder on the operation's registered reply
 * channel, answering on the request's correlation id — the same matching
 * `busRequest` does against a real Stower.
 */

import { describe, it, expect } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import {
  BUS_OPERATIONS,
  BusRequestError,
  EventBus,
  ResourceOperations,
  userId,
  type BusRequestPrimitive,
  type ConnectionState,
  type EventMap,
} from '../index';

const ALICE = userId('did:web:kb.example:users:alice');

function inProcess(bus: EventBus): BusRequestPrimitive {
  return {
    emit: async (channel, payload, envelope) => { bus.emit(channel, payload, envelope); return -1; },
    stream: (channel) => bus.on(channel),
    frames: (channel) => bus.frames(channel),
    isSubscribed: () => true,
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
  };
}

type Operation = 'yield:create' | 'yield:clone-persist' | 'yield:clone-create';

/**
 * Answer the next request on `operation` with `reply`, and hand back what the
 * request carried. The reply rides the operation's registered result channel,
 * so the test never names a reply channel itself.
 */
function stower<K extends Operation>(bus: EventBus, operation: K, resourceId: string): { seen: Promise<EventMap[K]> } {
  const seen = new Promise<EventMap[K]>((resolve) => {
    const sub = bus.frames(operation).subscribe((frame) => {
      sub.unsubscribe();
      const result = BUS_OPERATIONS[operation].result as keyof EventMap;
      bus.emit(result, { response: { resourceId } } as EventMap[typeof result], { correlationId: frame.correlationId });
      resolve(frame.payload);
    });
  });
  return { seen };
}

describe('ResourceOperations (exported from @semiont/core)', () => {
  it('createResource forwards every input field onto yield:create, stamps the caller, and returns the reply id', async () => {
    const bus = new EventBus();
    const { seen } = stower(bus, 'yield:create', 'res-1');

    const id = await ResourceOperations.createResource(
      {
        name: 'Paper',
        storageUri: 'file://paper.pdf',
        contentChecksum: 'abc',
        byteSize: 42,
        format: 'application/pdf',
        language: 'en',
        entityTypes: ['Paper'],
        generatedFrom: { resourceId: 'parent', annotationId: 'ann' },
        generationPrompt: 'summarise',
        jobId: 'job-7',
        isDraft: true,
      },
      ALICE,
      inProcess(bus),
    );

    expect(id).toBe('res-1');
    expect(await seen).toMatchObject({
      name: 'Paper',
      storageUri: 'file://paper.pdf',
      contentChecksum: 'abc',
      byteSize: 42,
      format: 'application/pdf',
      language: 'en',
      entityTypes: ['Paper'],
      generatedFrom: { resourceId: 'parent', annotationId: 'ann' },
      generationPrompt: 'summarise',
      jobId: 'job-7',
      isDraft: true,
      _userId: ALICE,
    });
    bus.destroy();
  });

  it('persistClone names its parent on yield:clone-persist', async () => {
    const bus = new EventBus();
    const { seen } = stower(bus, 'yield:clone-persist', 'clone-1');

    const id = await ResourceOperations.persistClone(
      {
        name: 'Copy',
        storageUri: 'file://copy.md',
        contentChecksum: 'def',
        byteSize: 7,
        format: 'text/markdown',
        parentResourceId: 'res-1',
      },
      ALICE,
      inProcess(bus),
    );

    expect(id).toBe('clone-1');
    expect(await seen).toMatchObject({ parentResourceId: 'res-1', _userId: ALICE });
    bus.destroy();
  });

  it('createFromCloneToken carries the token on yield:clone-create', async () => {
    const bus = new EventBus();
    const { seen } = stower(bus, 'yield:clone-create', 'clone-2');

    const id = await ResourceOperations.createFromCloneToken(
      {
        token: 'tok',
        name: 'Copy',
        storageUri: 'file://copy.md',
        contentChecksum: 'def',
        byteSize: 7,
        format: 'text/markdown',
        archiveOriginal: true,
      },
      ALICE,
      inProcess(bus),
    );

    expect(id).toBe('clone-2');
    expect(await seen).toMatchObject({ token: 'tok', archiveOriginal: true, _userId: ALICE });
    bus.destroy();
  });

  it('a failure reply rejects rather than resolving to an id', async () => {
    const bus = new EventBus();
    bus.frames('yield:create').subscribe((frame) => {
      bus.emit(BUS_OPERATIONS['yield:create'].failure, { message: 'disk full' }, { correlationId: frame.correlationId });
    });

    await expect(
      ResourceOperations.createResource(
        { name: 'x', storageUri: 'file://x', contentChecksum: 'c', byteSize: 1, format: 'text/plain' },
        ALICE,
        inProcess(bus),
      ),
    ).rejects.toBeInstanceOf(BusRequestError);
    bus.destroy();
  });
});
