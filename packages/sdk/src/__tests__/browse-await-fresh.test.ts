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
 * No backend: a fake transport returns an incrementing `browse:annotations-result`
 * so a fresh fetch is observably different from the memo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ITransport, ResourceId } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';

function makeFakeTransport() {
  const subjects = new Map<string, Subject<Record<string, unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) {
      s = new Subject<Record<string, unknown>>();
      subjects.set(channel, s);
    }
    return s;
  };

  // Each annotations request returns a distinct result so a fresh fetch is
  // observably different from a cached one.
  let n = 0;
  const transport = {
    baseUrl: 'http://test',
    emit: async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'browse:annotations-requested') {
        n += 1;
        subjectFor('browse:annotations-result').next({
          correlationId: payload.correlationId as string,
          response: { annotations: [{ id: `a${n}` }], total: 1 },
        });
      }
    },
    stream: (channel: string): Observable<Record<string, unknown>> => subjectFor(channel).asObservable(),
    subscribeToResource: () => () => {},
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  };

  return { transport: transport as unknown as ITransport };
}

const noopContent = {
  getBinary: async () => ({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
  getBinaryStream: async () => ({ stream: new ReadableStream(), contentType: 'text/plain' }),
  dispose: () => {},
} as unknown as IContentTransport;

describe('browse read — one-shot await is fresh (#847 Phase 2)', () => {
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

  it('a re-read reflects the latest backend value (not the stale memo)', async () => {
    const first = await browse.annotations(rId);
    expect(first[0]!.id).toBe('a1');

    // Simulates read → write → read: the backend now returns a newer value.
    const second = await browse.annotations(rId);
    expect(second[0]!.id).toBe('a2'); // fresh, not the cached 'a1'
  });

  it('still resolves the first read', async () => {
    const v = await browse.annotations(rId);
    expect(v).toHaveLength(1);
  });
});
