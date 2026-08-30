/**
 * The detection workers' anchored-text consult — ANCHORED-TEXT-TO-SMELTER D2/P3.
 *
 * The workers read this store over the bus and never write it: the Smelter is
 * the sole writer, and a worker that misses extracts locally and discards
 * (it needs `extracted.items` in-process regardless). These pins hold that
 * split in place — a future session that "completes" the store by wiring a
 * write breaks them, which is the point.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ExtractionOutcome, Logger } from '@semiont/core';
import { anchoredTextOverBus } from '../anchored-text-over-bus';

const OUTCOME: ExtractionOutcome = {
  kind: 'extracted',
  text: 'page one',
  method: 'pdf-text-layer',
  items: [],
};

type Consult = (checksum: string) => Promise<ExtractionOutcome | null>;

function withConsult(fn: Consult) {
  return { browse: { anchoredTextByChecksum: fn } };
}

describe('anchoredTextOverBus', () => {
  it('reads by checksum through the SDK consult', async () => {
    const consult = vi.fn<Consult>().mockResolvedValue(OUTCOME);
    const store = anchoredTextOverBus(withConsult(consult));

    await expect(store.read('sha-1')).resolves.toEqual(OUTCOME);
    expect(consult).toHaveBeenCalledExactlyOnceWith('sha-1');
  });

  it('serves a miss as null — the caller extracts locally', async () => {
    const store = anchoredTextOverBus(withConsult(vi.fn<Consult>().mockResolvedValue(null)));
    await expect(store.read('unknown')).resolves.toBeNull();
  });

  it('never throws: a failed consult is a miss, not an error', async () => {
    // The store contract's rule — the cache may make things faster, never
    // make them fail. A bus timeout must not fail a detection job.
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
    const store = anchoredTextOverBus(
      withConsult(vi.fn<Consult>().mockRejectedValue(new Error('bus timeout'))),
      logger,
    );

    await expect(store.read('sha-1')).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('does not write — the Smelter is the only writer', async () => {
    const consult = vi.fn<Consult>();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
    const store = anchoredTextOverBus(withConsult(consult), logger);

    await expect(store.write('sha-1', OUTCOME)).resolves.toBeUndefined();
    // No wire call of any kind: there is no write operation to reach for.
    expect(consult).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('lists nothing — the reconcile planner is the Smelter\'s, not a worker\'s', async () => {
    const store = anchoredTextOverBus(withConsult(vi.fn<Consult>()));
    await expect(store.list()).resolves.toEqual([]);
  });
});
