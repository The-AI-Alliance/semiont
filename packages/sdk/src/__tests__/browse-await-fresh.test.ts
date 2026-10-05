/**
 * A one-shot `.fresh()` read of a Browse live query returns a FRESH
 * value, not the stale memoized one, on re-read.
 *
 * A headless consumer (e.g. a loader's resume-guard) does `read → write →
 * read` in the same process. The first read populates the cache; without a
 * scoped subscription, no `mark:added` invalidation arrives, so a second
 * read served from the memo would be stale. `.fresh()` fetches
 * (`cache.fetch`) rather than serving the memo. `.subscribe(...)` keeps
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
    onEmit: (channel, _payload, envelope) => {
      if (channel === 'browse:annotations-requested') {
        n += 1;
        bus.emit('browse:annotations-result', {
          response: { annotations: [mockAnnotation(`a${n}`)], total: 1 },
        }, { correlationId: envelope?.correlationId });
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

// The one-shot read is the explicit `.fresh()`: a Browse live query is not
// thenable, so nothing awaits one directly.
describe('browse read — the one-shot .fresh() read is fresh', () => {
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

    // Simulates read → write → read: the second read's gateway value is newer.
    const second = await browse.annotations(rId).fresh();
    expect(second[0]!.id).toBe('a2'); // fresh, not the cached 'a1'
  });

  it('resolves the first read', async () => {
    const v = await browse.annotations(rId).fresh();
    expect(v).toHaveLength(1);
  });
});
