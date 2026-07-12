/**
 * WeaverActorStateUnit Tests (WEAVER-ISOLATION P2)
 *
 * Domain-event fan-in for the Weaver: the 9 graph-relevant channels merged
 * into one `StoredEvent`-typed `events$`. Transport-neutral over WorkerBus —
 * in-process today (core EventBus via the local shim), the bus gateway after
 * the split, with this unit unchanged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { WorkerBus } from '@semiont/sdk';
import { assertStateUnitAxioms } from '@semiont/core/testing';
import { createWeaverActorStateUnit, WEAVER_CHANNELS } from '../weaver-actor-state-unit';

function fakeBus() {
  const channels = new Set<string>();
  const streams = new Map<string, Subject<any>>();

  const getStream = (channel: string): Subject<any> => {
    let s = streams.get(channel);
    if (!s) {
      s = new Subject();
      streams.set(channel, s);
    }
    return s;
  };

  const bus: WorkerBus = {
    addChannels: vi.fn((cs: readonly string[]) => {
      cs.forEach((c) => channels.add(c));
    }),
    on$: vi.fn((channel: string) => getStream(channel).asObservable()),
    // Required by the WorkerBus shape; the fan-in never emits — the Weaver
    // itself emits weave:applied through its own bus handle.
    emit: vi.fn(async () => {}),
  };

  return {
    bus,
    channels,
    pushEvent: (channel: string, payload: any) => getStream(channel).next(payload),
  };
}

describe('createWeaverActorStateUnit', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('extends the shared bus with all 9 graph-relevant channels on start', () => {
    const unit = createWeaverActorStateUnit({ bus: h.bus });
    unit.start();

    for (const channel of [
      'yield:created',
      'mark:archived', 'mark:unarchived',
      'mark:added', 'mark:removed', 'mark:body-updated',
      'mark:entity-tag-added', 'mark:entity-tag-removed',
      'frame:entity-type-added',
    ]) {
      expect(h.channels.has(channel)).toBe(true);
    }
    expect(WEAVER_CHANNELS).toHaveLength(9);
  });

  it('passes StoredEvents through verbatim — metadata intact for the fold', () => {
    const unit = createWeaverActorStateUnit({ bus: h.bus });
    const seen: any[] = [];
    unit.events$.subscribe((e) => seen.push(e));
    unit.start();

    const stored = {
      id: 'evt-1',
      type: 'mark:added',
      resourceId: 'res-1',
      payload: { annotation: { id: 'ann-1' } },
      metadata: { sequenceNumber: 7 },
    };
    h.pushEvent('mark:added', stored);

    expect(seen).toHaveLength(1);
    // Verbatim — no re-shaping: the Weaver's fold needs payload AND
    // metadata.sequenceNumber (lastProcessed / weave:applied).
    expect(seen[0]).toBe(stored);
  });

  it('merges events across channels into one stream', () => {
    const unit = createWeaverActorStateUnit({ bus: h.bus });
    const seen: string[] = [];
    unit.events$.subscribe((e: any) => seen.push(e.type));
    unit.start();

    h.pushEvent('yield:created', { type: 'yield:created', metadata: { sequenceNumber: 1 } });
    h.pushEvent('frame:entity-type-added', { type: 'frame:entity-type-added', metadata: { sequenceNumber: 2 } });

    expect(seen).toEqual(['yield:created', 'frame:entity-type-added']);
  });

  it('start() is idempotent — channels widened once', () => {
    const unit = createWeaverActorStateUnit({ bus: h.bus });
    unit.start();
    unit.start();

    expect(h.bus.addChannels).toHaveBeenCalledTimes(1);
  });

  describe('StateUnit axioms', () => {
    it('satisfies the StateUnit axioms', () => {
      // No owned surfaces: `events$` is derived from the injected bus's `on$`.
      assertStateUnitAxioms({
        setup: () => createWeaverActorStateUnit({ bus: fakeBus().bus }),
        invocations: (u) => [() => u.start()],
      });
    });
  });
});
