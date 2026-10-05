/**
 * The bus carries FRAMES, and offers three verbs rather than a Subject.
 *
 * Handing out a raw `Subject<EventMap[K]>` has two consequences. Routing
 * metadata has nowhere to live except inside the domain payload, so
 * `correlationId` is declared in payload schemas and echoed by hand in
 * handlers. And nothing distinguishes publishing from observing: every
 * holder can write, read and pipe the same object, so the conflation stays
 * invisible.
 *
 * Three verbs, each answering one question:
 *   emit(channel, payload, envelope?)  -- the only write path
 *   on(channel)    -> Observable<payload>   (DERIVED from frames)
 *   frames(channel) -> Observable<BusFrame> (the envelope)
 *
 * A handler cannot tell which fabric it is on, so the envelope it reads must
 * not depend on the fabric: this is the same frame the wire carries.
 */
import { describe, test, expect } from 'vitest';
import { EventBus } from '../event-bus';
import type { EventMap } from '../bus-protocol';
import { resourceId } from '../identifiers';

const CH = 'beckon:hover' as const;
const payloadFor = (id: string): EventMap[typeof CH] => ({ annotationId: id }) as EventMap[typeof CH];

describe('EventBus carries frames and offers verbs', () => {
  test('emit + on: a payload subscriber sees the payload, envelope and all', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on(CH).subscribe((p) => seen.push(p));

    bus.emit(CH, payloadFor('a-1'));
    bus.emit(CH, payloadFor('a-2'), { correlationId: 'cid-1' });

    // `on` is the payload view: a correlated emit is still just a payload here.
    expect(seen).toEqual([payloadFor('a-1'), payloadFor('a-2')]);
  });

  test('frames: the envelope is carried beside the payload, never inside it', () => {
    const bus = new EventBus();
    const frames: Array<{ correlationId?: string; payload: unknown }> = [];
    bus.frames(CH).subscribe((f) => frames.push(f));

    bus.emit(CH, payloadFor('a-1'), { correlationId: 'cid-1' });

    expect(frames).toHaveLength(1);
    expect(frames[0]!.correlationId).toBe('cid-1');
    expect(frames[0]!.payload).toEqual(payloadFor('a-1'));
    // The whole point: the domain payload is untouched by routing metadata.
    expect(Object.keys(frames[0]!.payload as object)).not.toContain('correlationId');
  });

  test('an uncorrelated emit carries an envelope with no correlationId — absent, not empty-string', () => {
    const bus = new EventBus();
    const frames: Array<{ correlationId?: string }> = [];
    bus.frames(CH).subscribe((f) => frames.push(f));

    bus.emit(CH, payloadFor('a-1'));

    expect(frames[0]!.correlationId).toBeUndefined();
  });

  test('on is DERIVED from frames — the two views cannot disagree', () => {
    const bus = new EventBus();
    const payloads: unknown[] = [];
    const frames: unknown[] = [];
    bus.on(CH).subscribe((p) => payloads.push(p));
    bus.frames(CH).subscribe((f) => frames.push(f.payload));

    bus.emit(CH, payloadFor('a-1'));
    bus.emit(CH, payloadFor('a-2'), { correlationId: 'c' });

    expect(payloads).toEqual(frames);
  });

  test('no Subject escapes: there is one write path, and it is emit', () => {
    const bus = new EventBus();
    // There is no `get`. A caller holding a Subject could write, read and
    // pipe the same object, which keeps a payload/envelope conflation
    // invisible.
    expect((bus as unknown as Record<string, unknown>).get).toBeUndefined();
    const observable = bus.on(CH) as unknown as Record<string, unknown>;
    expect(observable.next, 'on() must not hand back a writable surface').toBeUndefined();
  });

  describe('scope rides the envelope too, and scopes stay isolated', () => {
    test('a scoped subscriber sees its own scope only', () => {
      const bus = new EventBus();
      const scoped: unknown[] = [];
      bus.scope(resourceId('res-1')).on(CH).subscribe((p) => scoped.push(p));

      bus.scope(resourceId('res-1')).emit(CH, payloadFor('mine'));
      bus.scope(resourceId('res-2')).emit(CH, payloadFor('theirs'));
      bus.emit(CH, payloadFor('unscoped'));

      expect(scoped).toEqual([payloadFor('mine')]);
    });

    test('an UNSCOPED subscriber does not see scoped emissions', () => {
      // Separate subjects would give this for free; a filtered view must state it.
      const bus = new EventBus();
      const unscoped: unknown[] = [];
      bus.on(CH).subscribe((p) => unscoped.push(p));

      bus.scope(resourceId('res-1')).emit(CH, payloadFor('scoped'));
      bus.emit(CH, payloadFor('global'));

      expect(unscoped).toEqual([payloadFor('global')]);
    });

    test('the scope is ON the frame, not in the channel name', () => {
      // The GLOBAL `frames()` does not see a scoped frame — that would
      // contradict the isolation test above; the global view is global.
      // What the field buys is that a scoped reader sees the scope as data
      // instead of having to parse it back out of a channel key.
      const bus = new EventBus();
      const frames: Array<{ scope?: string }> = [];
      bus.scope(resourceId('res-1')).frames(CH).subscribe((f) => frames.push(f));

      bus.scope(resourceId('res-1')).emit(CH, payloadFor('x'));
      bus.emit(CH, payloadFor('global'));

      expect(frames.map((f) => f.scope)).toEqual(['res-1']);
    });
  });
});
