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
 * No gateway: a stub content transport answers `getAnnotations` with an
 * incrementing list, so a fresh fetch is observably different from the memo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ResourceId } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';
import { inMemoryTransport, contentTransportSpies } from './helpers/in-memory-transport';
import { mockAnnotation } from './fixtures/annotation';

function makeContent(): IContentTransport {
  // Each annotations read returns a distinct result so a fresh fetch is
  // observably different from a cached one.
  let n = 0;
  return contentTransportSpies({
    getAnnotations: async () => {
      n += 1;
      return { annotations: [mockAnnotation(`a${n}`)], total: 1 };
    },
  });
}

// The one-shot read is the explicit `.fresh()`: a Browse live query is not
// thenable, so nothing awaits one directly.
describe('browse read — the one-shot .fresh() read is fresh', () => {
  let bus: EventBus;
  let browse: BrowseNamespace;
  const rId: ResourceId = makeResourceId('res-1');

  beforeEach(() => {
    bus = new EventBus();
    browse = new BrowseNamespace(inMemoryTransport(), bus, makeContent());
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
