/**
 * SmeltProgress Tests (SMELTER-INDEX-SYNC P1, D1 = push barrier)
 *
 * The backend-local fold of `smelt:settled` signals. `whenSettled` is the
 * read-your-writes barrier: it resolves with the Smelter's decision
 * (`indexed` | `skipped`) the moment the vector projection settles the
 * exact content generation the caller holds — event-driven, no polling
 * quantum — and rejects with a distinct error on the bounded timeout so
 * callers degrade observably (one L4 breadcrumb).
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '@semiont/core';
import { assertStateUnitAxioms } from '@semiont/core/testing';
import { createSmeltProgress, SmeltProgressTimeout } from '../smelt-progress';

describe('SmeltProgress', () => {
  it('resolves immediately when the fold already holds the settlement', async () => {
    const bus = new EventBus();
    const progress = createSmeltProgress(bus);
    bus.get('smelt:settled').next({ resourceId: 'res-1', contentChecksum: 'cs-a', outcome: 'indexed' });

    await expect(progress.whenSettled('res-1', 'cs-a', 1000)).resolves.toBe('indexed');
    expect(progress.settledAt('res-1')).toEqual({ contentChecksum: 'cs-a', outcome: 'indexed' });

    progress.dispose();
  });

  it('resolves when the signal arrives while waiting — event-driven, not polled', async () => {
    const bus = new EventBus();
    const progress = createSmeltProgress(bus);

    const wait = progress.whenSettled('res-1', 'cs-a', 1000);
    bus.get('smelt:settled').next({ resourceId: 'res-1', contentChecksum: 'cs-a', outcome: 'indexed' });

    await expect(wait).resolves.toBe('indexed');
    progress.dispose();
  });

  it('resolves skipped decisions — never-embeddable resources do not eat the timeout', async () => {
    const bus = new EventBus();
    const progress = createSmeltProgress(bus);

    const wait = progress.whenSettled('res-pdf', 'cs-pdf', 1000);
    bus.get('smelt:settled').next({ resourceId: 'res-pdf', contentChecksum: 'cs-pdf', outcome: 'skipped' });

    await expect(wait).resolves.toBe('skipped');
    progress.dispose();
  });

  it('a settlement at a different checksum does not resolve the waiter; the matching one does', async () => {
    const bus = new EventBus();
    const progress = createSmeltProgress(bus);

    const wait = progress.whenSettled('res-1', 'cs-new', 1000);
    bus.get('smelt:settled').next({ resourceId: 'res-1', contentChecksum: 'cs-old', outcome: 'indexed' });
    bus.get('smelt:settled').next({ resourceId: 'res-other', contentChecksum: 'cs-new', outcome: 'indexed' });
    bus.get('smelt:settled').next({ resourceId: 'res-1', contentChecksum: 'cs-new', outcome: 'indexed' });

    await expect(wait).resolves.toBe('indexed');
    progress.dispose();
  });

  it('the latest settlement wins — a new content generation replaces the fold entry', async () => {
    const bus = new EventBus();
    const progress = createSmeltProgress(bus);

    bus.get('smelt:settled').next({ resourceId: 'res-1', contentChecksum: 'cs-v1', outcome: 'indexed' });
    bus.get('smelt:settled').next({ resourceId: 'res-1', contentChecksum: 'cs-v2', outcome: 'skipped' });

    expect(progress.settledAt('res-1')).toEqual({ contentChecksum: 'cs-v2', outcome: 'skipped' });
    progress.dispose();
  });

  it('rejects with the distinct timeout error when no matching settlement comes', async () => {
    const bus = new EventBus();
    const progress = createSmeltProgress(bus);

    await expect(progress.whenSettled('res-ghost', 'cs-x', 20)).rejects.toBeInstanceOf(SmeltProgressTimeout);
    progress.dispose();
  });

  it('dispose resolves pending waiters inert — shutdown never throws through a gather', async () => {
    const bus = new EventBus();
    const progress = createSmeltProgress(bus);

    const wait = progress.whenSettled('res-1', 'cs-a', 60_000);
    progress.dispose();

    await expect(wait).resolves.toBe('inert');
  });

  describe('StateUnit axioms', () => {
    it('satisfies the StateUnit axioms', () => {
      assertStateUnitAxioms({
        setup: () => createSmeltProgress(new EventBus()),
        invocations: (u) => [() => u.settledAt('res-1')],
      });
    });
  });
});
