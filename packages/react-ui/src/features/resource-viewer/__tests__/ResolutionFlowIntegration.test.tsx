/**
 * Layer 3: Feature Integration Test - Resolution Flow (search modal & body update)
 *
 * Tests the UNCOVERED half of useResolutionFlow:
 * - reference:link → emits resolution:search-requested
 * - resolution:search-requested → opens search modal with pendingReferenceId
 * - onCloseSearchModal → closes modal
 * - annotation:update-body → calls updateAnnotationBody API
 * - annotation:update-body → emits annotation:body-updated on success
 * - annotation:update-body → emits annotation:body-update-failed on error
 * - auth token passed to updateAnnotationBody
 *
 * The deletion half of useResolutionFlow is covered by AnnotationDeletionIntegration.test.tsx.
 *
 * Uses real providers (EventBus, ApiClient, AuthToken) with mocked API boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useResolutionFlow } from '../../../hooks/useResolutionFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceUri, accessToken } from '@semiont/core';

describe('Resolution Flow - Search Modal & Body Update Integration', () => {
  let updateAnnotationBodySpy: ReturnType<typeof vi.fn>;
  const testUri = resourceUri('http://localhost:4000/resources/test-resource');
  const testToken = 'test-resolution-token';
  const testBaseUrl = 'http://localhost:4000';

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    updateAnnotationBodySpy = vi.fn().mockResolvedValue({ success: true });
    vi.spyOn(SemiontApiClient.prototype, 'updateAnnotationBody').mockImplementation(updateAnnotationBodySpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Render helper ──────────────────────────────────────────────────────────

  function renderResolutionFlow() {
    let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
    let lastState: ReturnType<typeof useResolutionFlow> | null = null;

    function TestComponent() {
      eventBusInstance = useEventBus();
      lastState = useResolutionFlow(testUri);
      return null;
    }

    render(
      <AuthTokenProvider token={testToken}>
        <EventBusProvider>
          <ApiClientProvider baseUrl={testBaseUrl}>
            <TestComponent />
          </ApiClientProvider>
        </EventBusProvider>
      </AuthTokenProvider>
    );

    return {
      getState: () => lastState!,
      emit: (event: Parameters<typeof eventBusInstance.emit>[0], payload: Parameters<typeof eventBusInstance.emit>[1]) => {
        act(() => { eventBusInstance!.get(event as any).next(payload as any); });
      },
      on: (event: Parameters<typeof eventBusInstance.on>[0], handler: (payload: any) => void) => {
        return eventBusInstance!.get(event as any).subscribe(handler);
      },
    };
  }

  // ─── Initial state ──────────────────────────────────────────────────────────

  it('starts with search modal closed and no pending reference', () => {
    const { getState } = renderResolutionFlow();
    expect(getState().searchModalOpen).toBe(false);
    expect(getState().pendingReferenceId).toBeNull();
  });

  // ─── reference:link ─────────────────────────────────────────────────────────

  it('reference:link emits resolution:search-requested with referenceId and searchTerm', () => {
    const { emit, on } = renderResolutionFlow();
    const searchRequestedSpy = vi.fn();

    const unsubscribe = on('resolution:search-requested', searchRequestedSpy);
    emit('reference:link', { annotationUri: 'ann-uri-123', searchTerm: 'climate change' });
    subscription.unsubscribe();

    expect(searchRequestedSpy).toHaveBeenCalledTimes(1);
    expect(searchRequestedSpy).toHaveBeenCalledWith({
      referenceId: 'ann-uri-123',
      searchTerm: 'climate change',
    });
  });

  // ─── resolution:search-requested ────────────────────────────────────────────

  it('resolution:search-requested opens the search modal', async () => {
    const { getState, emit } = renderResolutionFlow();

    expect(getState().searchModalOpen).toBe(false);

    emit('resolution:search-requested', { referenceId: 'ref-abc', searchTerm: 'oceans' });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
    });
  });

  it('resolution:search-requested sets pendingReferenceId', async () => {
    const { getState, emit } = renderResolutionFlow();

    emit('resolution:search-requested', { referenceId: 'ref-xyz', searchTerm: 'forests' });

    await waitFor(() => {
      expect(getState().pendingReferenceId).toBe('ref-xyz');
    });
  });

  it('reference:link → resolution:search-requested chain opens modal end-to-end', async () => {
    const { getState, emit } = renderResolutionFlow();

    // Simulate the full user journey: user clicks "Link Document" on a reference entry
    emit('reference:link', { annotationUri: 'ann-full-chain', searchTerm: 'biodiversity' });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
      expect(getState().pendingReferenceId).toBe('ann-full-chain');
    });
  });

  // ─── onCloseSearchModal ──────────────────────────────────────────────────────

  it('onCloseSearchModal closes the search modal', async () => {
    const { getState, emit } = renderResolutionFlow();

    emit('resolution:search-requested', { referenceId: 'ref-close', searchTerm: 'test' });

    await waitFor(() => expect(getState().searchModalOpen).toBe(true));

    act(() => { getState().onCloseSearchModal(); });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(false);
    });
  });

  it('onCloseSearchModal does not clear pendingReferenceId (preserves for re-open)', async () => {
    const { getState, emit } = renderResolutionFlow();

    emit('resolution:search-requested', { referenceId: 'ref-persist', searchTerm: 'test' });
    await waitFor(() => expect(getState().searchModalOpen).toBe(true));

    act(() => { getState().onCloseSearchModal(); });
    await waitFor(() => expect(getState().searchModalOpen).toBe(false));

    // pendingReferenceId remains — modal may reopen
    expect(getState().pendingReferenceId).toBe('ref-persist');
  });

  // ─── annotation:update-body ──────────────────────────────────────────────────

  it('annotation:update-body calls updateAnnotationBody API', async () => {
    const { emit } = renderResolutionFlow();

    emit('annotation:update-body', {
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-body-1',
      resourceId: 'linked-resource-id',
      operations: [{ op: 'add', item: { id: 'linked-resource-id' } }],
    });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalledTimes(1);
    });
  });

  it('annotation:update-body passes auth token to API call', async () => {
    const { emit } = renderResolutionFlow();

    emit('annotation:update-body', {
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-auth',
      resourceId: 'resource-id',
      operations: [{ op: 'replace', newItem: { id: 'resource-id' } }],
    });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalled();
    });

    const callArgs = updateAnnotationBodySpy.mock.calls[0];
    expect(callArgs[2]).toHaveProperty('auth');
    expect(callArgs[2].auth).toBe(accessToken(testToken));
  });

  it('annotation:update-body emits annotation:body-updated on success', async () => {
    const { emit, on } = renderResolutionFlow();
    const bodyUpdatedSpy = vi.fn();

    const unsubscribe = on('annotation:body-updated', bodyUpdatedSpy);

    emit('annotation:update-body', {
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-success',
      resourceId: 'resource-id',
      operations: [{ op: 'add', item: { id: 'resource-id' } }],
    });

    await waitFor(() => {
      expect(bodyUpdatedSpy).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();

    expect(bodyUpdatedSpy).toHaveBeenCalledWith({
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-success',
    });
  });

  it('annotation:update-body emits annotation:body-update-failed on API error', async () => {
    updateAnnotationBodySpy.mockRejectedValue(new Error('Update failed'));

    const { emit, on } = renderResolutionFlow();
    const bodyUpdateFailedSpy = vi.fn();

    const unsubscribe = on('annotation:body-update-failed', bodyUpdateFailedSpy);

    emit('annotation:update-body', {
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-fail',
      resourceId: 'resource-id',
      operations: [{ op: 'remove', item: { id: 'old-id' } }],
    });

    await waitFor(() => {
      expect(bodyUpdateFailedSpy).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();

    expect(bodyUpdateFailedSpy).toHaveBeenCalledWith({
      error: expect.any(Error),
    });
  });

  it('annotation:update-body called ONCE — no duplicate subscriptions', async () => {
    const { emit } = renderResolutionFlow();

    emit('annotation:update-body', {
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-dedup',
      resourceId: 'resource-id',
      operations: [{ op: 'add', item: { id: 'resource-id' } }],
    });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalledTimes(1);
    });
  });
});
