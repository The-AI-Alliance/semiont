/**
 * WeaveProgress Tests (GRAPH-PROJECTION-SYNC P2, D2 = push)
 *
 * The backend-local fold of `weave:applied` signals. `whenApplied` is the
 * applied-offset barrier: it resolves as soon as the Weaver's applied
 * sequence for a resource reaches the requested one, event-driven — no
 * polling quantum — and rejects with a distinct error on the bounded
 * timeout so callers can fall back to the Phase 1 retry floor.
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '@semiont/core';
import { assertStateUnitAxioms } from '@semiont/core/testing';
import { createWeaveProgress, WeaveProgressTimeout } from '../weave-progress';

describe('WeaveProgress', () => {
  it('resolves immediately when the applied map already covers the sequence', async () => {
    const bus = new EventBus();
    const progress = createWeaveProgress(bus);
    bus.get('weave:applied').next({ resourceId: 'res-1', sequenceNumber: 5 });

    await expect(progress.whenApplied('res-1', 3, 1000)).resolves.toBeUndefined();
    await expect(progress.whenApplied('res-1', 5, 1000)).resolves.toBeUndefined();
    expect(progress.appliedUpTo('res-1')).toBe(5);

    progress.dispose();
  });

  it('resolves when the signal arrives while waiting — event-driven, not polled', async () => {
    const bus = new EventBus();
    const progress = createWeaveProgress(bus);

    const wait = progress.whenApplied('res-1', 7, 1000);
    bus.get('weave:applied').next({ resourceId: 'res-1', sequenceNumber: 7 });

    await expect(wait).resolves.toBeUndefined();
    progress.dispose();
  });

  it('ignores signals for other resources and lower sequences', async () => {
    const bus = new EventBus();
    const progress = createWeaveProgress(bus);

    const wait = progress.whenApplied('res-1', 7, 50);
    bus.get('weave:applied').next({ resourceId: 'res-other', sequenceNumber: 9 });
    bus.get('weave:applied').next({ resourceId: 'res-1', sequenceNumber: 6 });

    await expect(wait).rejects.toBeInstanceOf(WeaveProgressTimeout);
    progress.dispose();
  });

  it('rejects with the distinct timeout error when the signal never comes', async () => {
    const bus = new EventBus();
    const progress = createWeaveProgress(bus);

    await expect(progress.whenApplied('res-ghost', 1, 20)).rejects.toBeInstanceOf(WeaveProgressTimeout);
    progress.dispose();
  });

  it('applied sequences only advance — a stale lower signal never regresses the map', async () => {
    const bus = new EventBus();
    const progress = createWeaveProgress(bus);

    bus.get('weave:applied').next({ resourceId: 'res-1', sequenceNumber: 9 });
    bus.get('weave:applied').next({ resourceId: 'res-1', sequenceNumber: 4 });

    expect(progress.appliedUpTo('res-1')).toBe(9);
    progress.dispose();
  });

  it('post-dispose whenApplied is inert — resolves so callers degrade to the retry floor', async () => {
    const bus = new EventBus();
    const progress = createWeaveProgress(bus);
    progress.dispose();

    await expect(progress.whenApplied('res-1', 99, 1000)).resolves.toBeUndefined();
  });

  describe('StateUnit axioms', () => {
    it('satisfies the StateUnit axioms', () => {
      assertStateUnitAxioms({
        setup: () => createWeaveProgress(new EventBus()),
        invocations: (u) => [() => u.appliedUpTo('res-1')],
      });
    });
  });
});
