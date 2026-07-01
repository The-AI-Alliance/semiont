/**
 * EMBEDDABLE-RESOURCE-VIEWER step 2 — useResourceLoader.
 *
 * A standalone loader: given a bare client, it fetches the resource + its
 * annotations (grouped into an AnnotationsCollection) and reports loading/error —
 * no page, no composite state unit, no providers. The lightweight alternative to
 * ResourceViewerPage that a bring-your-own-session host can feed into ResourceViewer.
 *
 * Started RED (the hook does not exist) and GREEN once step 2 lands.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import { resourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { useResourceLoader } from '../useResourceLoader';

const RES = { '@id': 'res-1', name: 'Doc' };

function makeClient(resource$: BehaviorSubject<unknown>, annotations$: BehaviorSubject<unknown>): SemiontClient {
  return { browse: { resource: () => resource$, annotations: () => annotations$ } } as unknown as SemiontClient;
}

describe('useResourceLoader', () => {
  it('loads the resource + grouped annotations from a bare client', () => {
    const resource$ = new BehaviorSubject<unknown>(undefined);
    const annotations$ = new BehaviorSubject<unknown>(undefined);
    const client = makeClient(resource$, annotations$);
    const rid = resourceId('res-1');

    const { result } = renderHook(() => useResourceLoader(client, rid));

    // Nothing emitted yet → loading.
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    act(() => {
      resource$.next(RES);
      annotations$.next([{ motivation: 'highlighting' }, { motivation: 'linking' }, { motivation: 'linking' }]);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.resource).toEqual(RES);
    expect(result.current.annotations.highlights).toHaveLength(1);
    expect(result.current.annotations.references).toHaveLength(2);
    expect(result.current.annotations.comments).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it('stays loading (no subscription) without a client', () => {
    const { result } = renderHook(() => useResourceLoader(null, resourceId('res-1')));
    expect(result.current.loading).toBe(true);
    expect(result.current.resource).toBeUndefined();
  });
});
