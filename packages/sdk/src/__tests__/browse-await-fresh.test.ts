/**
 * #847 Phase 2 — a one-shot `await` of a Browse live-query returns a FRESH
 * value, not the stale memoized one, on re-read.
 *
 * A headless consumer (e.g. a loader's resume-guard) does `read → write →
 * read` in the same process. The first read populates the cache; without a
 * scoped subscription, no `mark:added` invalidation arrives, so the second
 * `await` previously returned the stale memo. The fix: the await path fetches
 * fresh (`cache.fetch`) rather than serving the memo. `.subscribe(...)` keeps
 * the stale-while-revalidate cached view.
 *
 * No gateway: a fake transport returns an incrementing `browse:annotations-result`
 * so a fresh fetch is observably different from the memo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ResourceId } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';
import { inMemoryTransport } from './helpers/in-memory-transport';
import { mockAnnotation } from './fixtures/annotation';

function makeFakeTransport() {
  // Each annotations request returns a distinct result so a fresh fetch is
  // observably different from a cached one.
  let n = 0;
  const bus = new EventBus();
  const transport = inMemoryTransport({
    bus,
    onEmit: (channel, payload) => {
      if (channel === 'browse:annotations-requested') {
        n += 1;
        bus.emit('browse:annotations-result', {
          correlationId: (payload as { correlationId: string }).correlationId,
          response: { annotations: [mockAnnotation(`a${n}`)], total: 1 },
        });
      }
    },
  });

  return { transport };
}

const noopContent = {
  getBinary: async () => ({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
  getBinaryStream: async () => ({ stream: new ReadableStream(), contentType: 'text/plain' }),
  dispose: () => {},
} as unknown as IContentTransport;

describe('browse read — the one-shot .fresh() read is fresh (#847; D2 made it explicit)', () => {
  let bus: EventBus;
  let browse: BrowseNamespace;
  const rId: ResourceId = makeResourceId('res-1');

  beforeEach(() => {
    bus = new EventBus();
    browse = new BrowseNamespace(makeFakeTransport().transport, bus, noopContent);
  });

  afterEach(() => {
    bus.destroy();
  });

  it('a re-read reflects the latest gateway value (not the stale memo)', async () => {
    const first = await browse.annotations(rId).fresh();
    expect(first[0]!.id).toBe('a1');

    // Simulates read → write → read: the gateway now returns a newer value.
    const second = await browse.annotations(rId).fresh();
    expect(second[0]!.id).toBe('a2'); // fresh, not the cached 'a1'
  });

  it('still resolves the first read', async () => {
    const v = await browse.annotations(rId).fresh();
    expect(v).toHaveLength(1);
  });
});
