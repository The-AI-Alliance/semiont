/**
 * MULTI-RESOURCE-SCOPE Step 5 — the multi-mount invalidation contract.
 *
 * With N viewers mounted on one session (the embeddable "resource per chat
 * message" pattern — 40–60 concurrent in the surveyed consumer), a mark
 * event must cost ONE invalidation, of the right resource's list — not N.
 *
 * The invalidation belongs to the sdk: `BrowseNamespace.subscribeToEvents`
 * already invalidates payload-keyed on mark:added/mark:removed and patches
 * mark:body-updated in place. `ResourceViewer` therefore subscribes to NO
 * mark:* channels at all — a viewer-side handler was pure duplication, and
 * unfiltered it was an O(N) refetch amplification. This suite pins the
 * system behavior over the real client with two mounted viewers:
 * exactly one list invalidation per mark event, zero for body updates.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ResourceDescriptor as SemiontResource, ResourceId, StoredEvent, EventOfType, UserId, EventMetadata, Annotation } from '@semiont/core';
import { annotationId, resourceId as makeResourceId } from '@semiont/core';
import { createTestSemiontWrapper } from '../../../test-utils';
import { ResourceViewer } from '../ResourceViewer';

const TEST_USER = 'did:web:test:users:test' as UserId;

function makeResource(id: string): SemiontResource & { content: string } {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    '@id': id as ResourceId,
    name: `Doc ${id}`,
    created: '2024-01-01T00:00:00Z',
    entityTypes: [],
    archived: false,
    representations: [{ mediaType: 'text/plain', byteSize: 10 }],
    content: `Content of ${id}.`,
  };
}

function mockAnnotation(rIdStr: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId('ann-1'),
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: rIdStr },
    body: [{ type: 'TextualBody', value: 'c', purpose: 'commenting' }],
  };
}

function fakeMarkAdded(rIdStr: string): StoredEvent<EventOfType<'mark:added'>> {
  return {
    id: 'evt-1',
    type: 'mark:added',
    resourceId: makeResourceId(rIdStr),
    userId: TEST_USER,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { annotation: mockAnnotation(rIdStr) },
    metadata: { sequenceNumber: 1 } as EventMetadata,
  };
}

const annotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function mountTwoViewers() {
  const wrapper = createTestSemiontWrapper();
  const spy = vi.spyOn(wrapper.client.browse, 'invalidateAnnotationList');
  render(
    <>
      <ResourceViewer
        session={wrapper.session}
        resource={makeResource('res-A')}
        annotations={annotations}
        onOpenResource={vi.fn()}
        onOpenPanel={vi.fn()}
      />
      <ResourceViewer
        session={wrapper.session}
        resource={makeResource('res-B')}
        annotations={annotations}
        onOpenResource={vi.fn()}
        onOpenPanel={vi.fn()}
      />
    </>,
  );
  spy.mockClear(); // only the event-driven invalidations count
  return { ...wrapper, spy };
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe('ResourceViewer — multi-mount invalidation is per-resource and O(1), not O(N)', () => {
  it("a mark:added for res-A costs exactly ONE invalidation — res-A's, from the sdk", async () => {
    const { eventBus, spy } = mountTwoViewers();

    act(() => {
      eventBus.get('mark:added').next(fakeMarkAdded('res-A'));
    });

    await waitFor(() => expect(spy).toHaveBeenCalledWith('res-A'));
    expect(spy).not.toHaveBeenCalledWith('res-B');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a mark:removed for res-B costs exactly ONE invalidation — res-B's", async () => {
    const { eventBus, spy } = mountTwoViewers();

    act(() => {
      eventBus.get('mark:removed').next({
        id: 'evt-2',
        type: 'mark:removed',
        resourceId: makeResourceId('res-B'),
        userId: TEST_USER,
        version: 1,
        timestamp: '2026-01-01T00:00:00Z',
        payload: { annotationId: annotationId('ann-1') },
        metadata: { sequenceNumber: 2 } as EventMetadata,
      });
    });

    await waitFor(() => expect(spy).toHaveBeenCalledWith('res-B'));
    expect(spy).not.toHaveBeenCalledWith('res-A');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a mark:body-updated costs ZERO list invalidations — the sdk patches in place', async () => {
    const { eventBus, spy } = mountTwoViewers();

    act(() => {
      eventBus.get('mark:body-updated').next({
        resourceId: makeResourceId('res-A'),
        annotation: mockAnnotation('res-A'),
      } as never);
    });
    await flush();

    expect(spy).not.toHaveBeenCalled();
  });
});
