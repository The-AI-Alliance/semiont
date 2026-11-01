/**
 * The bus's reads: a channel's frames, each with its envelope, who emitted it
 * and the trace it was sent under; and a channel of a resource's scope read
 * for one resource, holding that scope while it is read. Its requests are
 * bus-request.test.ts's.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Bus, FrameRefusal, type Delivered, type Heard } from '../bus';
import { FaultyTransport } from '../faulty-transport';
import { EventBus } from '../event-bus';
import type { EventMap } from '../bus-protocol';
import type { BusFrame, TraceCarrier } from '../event-bus';
import { annotationId, jobId, resourceId, userId } from '../identifiers';
import type { EventMetadata, EventOfType, StoredEvent } from '../index';

const RID = resourceId('res-1');
const OTHER = resourceId('res-2');
const ALICE = userId('did:web:example.org:users:alice');
const META: EventMetadata = { sequenceNumber: 1 };

function archived(of: typeof RID): StoredEvent<EventOfType<'mark:archived'>> {
  return {
    id: `evt-${of}`,
    type: 'mark:archived',
    resourceId: of,
    userId: ALICE,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: {},
    metadata: META,
  };
}

/** Every value `observable` gives from now on. */
function collect<T>(observable: Observable<T>): { seen: T[]; stop: () => void } {
  const seen: T[] = [];
  const subscription = observable.subscribe((value) => seen.push(value));
  return { seen, stop: () => subscription.unsubscribe() };
}

/** `heard` as the frame it is; a test that reads a refusal here fails. */
function delivered<T>(heard: Heard<T>): Delivered<T> {
  if (heard.status === 'refused') throw new Error(`refused: ${heard.channel} lacks ${heard.lacks}`);
  return heard;
}

describe('Bus.frames: a channel of no scope', () => {
  it('gives each frame with its envelope and who emitted it, as the gateway stamped it', () => {
    const transport = new FaultyTransport();
    const wire = new Bus(transport);
    const { seen } = collect(wire.frames('beckon:focus'));

    const focus: EventMap['beckon:focus'] & { _userId: string } = {
      annotationId: annotationId('ann-1'),
      resourceId: RID,
      _userId: ALICE,
    };
    void transport.emit('beckon:focus', focus, { correlationId: 'c-1' });

    expect(seen.map(delivered).map((frame) => [frame.status, frame.correlationId, frame.userId, frame.scope, frame.payload.annotationId])).toEqual([
      ['delivered', 'c-1', ALICE, undefined, 'ann-1'],
    ]);
  });

  it('leaves out of a payload a stamp its channel does not declare, and keeps one it does', () => {
    const transport = new FaultyTransport();
    const { seen } = collect(new Bus(transport).frames('job:fail'));

    const failed = { resourceId: RID, jobId: jobId('job-1'), jobType: 'mark', error: 'the model did not answer' } as const;
    const stamped: EventMap['job:fail'] & { _roles: string[] } = { ...failed, _userId: ALICE, _roles: ['semiont-service'] };
    void transport.emit('job:fail', stamped);

    expect(seen.map(delivered).map((frame) => frame.payload)).toEqual([{ ...failed, _userId: ALICE }]);
  });

  it('gives the trace a frame was sent under, when the transport received one', () => {
    const trace: TraceCarrier = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' };
    class Traced extends FaultyTransport {
      override frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>> {
        return super.frames(channel).pipe(map((frame) => ({ ...frame, trace })));
      }
    }
    const transport = new Traced();
    const { seen } = collect(new Bus(transport).frames('beckon:focus'));

    void transport.emit('beckon:focus', { resourceId: RID, annotationId: annotationId('ann-1') });

    expect(seen.map(delivered).map((frame) => frame.trace)).toEqual([trace]);
  });

  it('refuses a channel of a resource\'s scope read with no resource: it would hear nothing', () => {
    const transport = new FaultyTransport();
    const held = vi.spyOn(transport, 'subscribeToResource');

    // @ts-expect-error — mark:archived is delivered on its resource's scope, so a read of it names the resource
    expect(() => new Bus(transport).frames('mark:archived')).toThrow(TypeError);
    expect(held).not.toHaveBeenCalled();
  });
});

/**
 * A payload that lacks a member its channel's schema requires is not that
 * channel's: a typed read gives, in place of its frame, a `FrameRefusal` that
 * names the channel and the way to the member it lacks, with the payload as
 * it came, and goes on, as every SDK's typed read does. A transport's bridge
 * publishes the refusal on the bus it feeds, in place of the payload.
 */
describe('Bus.frames: a payload that is not its channel\'s', () => {
  const failed: EventMap['job:fail'] = { resourceId: RID, jobId: jobId('job-1'), jobType: 'mark', error: 'the model did not answer' };

  /** `failed` as a peer might send it, with no job id: what its type says it cannot be. */
  function withNoJobId(): EventMap['job:fail'] {
    const lacking = { ...failed };
    Reflect.deleteProperty(lacking, 'jobId');
    return lacking;
  }

  it('is told the reader in place of its frame, by the way to what it lacks; the frames after it follow', () => {
    const warned = vi.spyOn(console, 'warn');
    try {
      const transport = new FaultyTransport();
      const { seen } = collect(new Bus(transport).frames('job:fail'));
      const lacking = withNoJobId();
      void transport.emit('job:fail', lacking);
      void transport.emit('job:fail', failed);

      const [refused, next] = seen;
      expect(seen).toHaveLength(2);
      expect(refused).toBeInstanceOf(FrameRefusal);
      expect(refused).toStrictEqual(new FrameRefusal('job:fail', 'jobId', lacking));
      expect(refused?.status).toBe('refused');
      expect(next !== undefined && delivered(next).payload).toEqual(failed);
      // The reader is told, and nothing is said in its place.
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it('is published, in place of the payload, on the bus a transport bridges into', () => {
    const warned = vi.spyOn(console, 'warn');
    try {
      const transport = new FaultyTransport();
      const bridged = new EventBus();
      transport.bridgeInto(bridged);
      const { seen } = collect(bridged.on('job:fail'));
      const lacking = withNoJobId();
      void transport.emit('job:fail', lacking);
      void transport.emit('job:fail', failed);

      expect(seen).toStrictEqual([new FrameRefusal('job:fail', 'jobId', lacking), failed]);
      expect(warned).not.toHaveBeenCalled();
      bridged.destroy();
    } finally {
      warned.mockRestore();
    }
  });
});

describe('Bus.frames: a channel of a resource\'s scope', () => {
  it("holds the resource's scope for as long as it is read, and gives that resource's frames only", () => {
    const transport = new FaultyTransport();
    const leave = vi.fn();
    const held = vi.spyOn(transport, 'subscribeToResource').mockReturnValue(leave);
    const reading = collect(new Bus(transport).frames('mark:archived', RID));
    expect(held).toHaveBeenCalledExactlyOnceWith(RID);

    // A stream carries every scope it holds on the one channel: another
    // resource's events are there too.
    void transport.emit('mark:archived', archived(RID), { scope: RID });
    void transport.emit('mark:archived', archived(OTHER), { scope: OTHER });
    expect(reading.seen.map(delivered).map((frame) => [frame.payload.id, frame.scope])).toEqual([['evt-res-1', RID]]);
    expect(leave).not.toHaveBeenCalled();

    reading.stop();
    expect(leave).toHaveBeenCalledOnce();
    void transport.emit('mark:archived', archived(RID), { scope: RID });
    expect(reading.seen).toHaveLength(1);
  });

  it('holds no scope until it is read', () => {
    const transport = new FaultyTransport();
    const held = vi.spyOn(transport, 'subscribeToResource');

    new Bus(transport).frames('mark:archived', RID);

    expect(held).not.toHaveBeenCalled();
  });

  it('refuses a channel of no scope read for a resource: it would hold a scope and hear nothing', () => {
    const transport = new FaultyTransport();
    const held = vi.spyOn(transport, 'subscribeToResource');

    // @ts-expect-error — beckon:hover is no resource's channel
    expect(() => new Bus(transport).frames('beckon:hover', RID)).toThrow(TypeError);
    expect(held).not.toHaveBeenCalled();
  });
});

describe('Bus.emit', () => {
  it('sends on the transport, envelope and all, and gives what the transport counted', async () => {
    const transport = new FaultyTransport();
    const { seen } = collect(transport.frames('beckon:sparkle'));

    const count = await new Bus(transport).emit('beckon:sparkle', { annotationId: annotationId('ann-1') }, { correlationId: 'c-2' });

    expect(count).toBe(1);
    expect(seen.map((frame) => frame.correlationId)).toEqual(['c-2']);
  });
});
