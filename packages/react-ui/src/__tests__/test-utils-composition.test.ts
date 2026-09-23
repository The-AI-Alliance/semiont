/**
 * test-utils composes working in-memory doubles — no network, and a live
 * query that actually resolves.
 *
 * The no-network half is enforced by `vitest.setup.ts`, whose `fetch` throws;
 * this test would fail there rather than here if the wiring regressed. What
 * it adds is the other half: that the wrapper's client is not merely offline
 * but *functional* — a `browse.*` live query reaches the in-memory transport
 * and settles. A double that silently answers nothing would pass a
 * no-network check and still make every component test a liar.
 *
 * .plans/TEST-UTILS-IN-MEMORY-TRANSPORT.md
 */

import { describe, it, expect } from 'vitest';
import { firstValueFrom, timer } from 'rxjs';
import { createTestSemiontWrapper } from '../test-utils';

describe('test-utils composition', () => {
  it('a live query over the wrapper client settles without touching the network', async () => {
    const { client } = createTestSemiontWrapper();

    let settled = 'pending';
    const querySub = client.browse
      .tagSchemas()
      .subscribe({ next: () => (settled = 'next'), error: (e) => (settled = `error: ${e?.message}`) });
    const busSub = client.bus.on('yield:created').subscribe(() => {});

    await firstValueFrom(timer(10));
    querySub.unsubscribe();
    busSub.unsubscribe();

    expect(settled).toBe('next');
  });
});
