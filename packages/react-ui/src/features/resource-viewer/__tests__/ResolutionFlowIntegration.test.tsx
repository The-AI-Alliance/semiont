/**
 * Layer 3: Feature Integration Test - Resolution Flow (search modal & body update)
 *
 * Tests the UNCOVERED half of useResolutionFlow:
 * - resolve:link → emits resolve:search-requested
 * - resolve:search-requested → opens search modal with pendingReferenceId
 * - onCloseSearchModal → closes modal
 * - resolve:update-body → calls updateAnnotationBody API
 * - resolve:update-body → emits resolve:body-updated on success
 * - resolve:update-body → emits resolve:body-update-failed on error
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

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

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
      getEventBus: () => eventBusInstance!,
    };
  }

  // ─── Initial state ──────────────────────────────────────────────────────────

  it('starts with search modal closed and no pending reference', () => {
    const { getState } = renderResolutionFlow();
    expect(getState().searchModalOpen).toBe(false);
    expect(getState().pendingReferenceId).toBeNull();
  });

  // ─── resolve:link ─────────────────────────────────────────────────────────

  it('resolve:link emits resolve:search-requested with referenceId and searchTerm', () => {
    const { getEventBus } = renderResolutionFlow();
    const searchRequestedSpy = vi.fn();

    const subscription = getEventBus().get('resolve:search-requested').subscribe(searchRequestedSpy);
    act(() => { getEventBus().get('resolve:link').next({ annotationUri: 'ann-uri-123', searchTerm: 'climate change' }); });
    subscription.unsubscribe();

    expect(searchRequestedSpy).toHaveBeenCalledTimes(1);
    expect(searchRequestedSpy).toHaveBeenCalledWith({
      referenceId: 'ann-uri-123',
      searchTerm: 'climate change',
    });
  });

  // ─── resolve:search-requested ────────────────────────────────────────────

  it('resolve:search-requested opens the search modal', async () => {
    const { getState, getEventBus } = renderResolutionFlow();

    expect(getState().searchModalOpen).toBe(false);

    act(() => { getEventBus().get('resolve:search-requested').next({ referenceId: 'ref-abc', searchTerm: 'oceans' }); });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
    });
  });

  it('resolve:search-requested sets pendingReferenceId', async () => {
    const { getState, getEventBus } = renderResolutionFlow();

    act(() => { getEventBus().get('resolve:search-requested').next({ referenceId: 'ref-xyz', searchTerm: 'forests' }); });

    await waitFor(() => {
      expect(getState().pendingReferenceId).toBe('ref-xyz');
    });
  });

  it('resolve:link → resolve:search-requested chain opens modal end-to-end', async () => {
    const { getState, getEventBus } = renderResolutionFlow();

    // Simulate the full user journey: user clicks "Link Document" on a reference entry
    act(() => { getEventBus().get('resolve:link').next({ annotationUri: 'ann-full-chain', searchTerm: 'biodiversity' }); });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
      expect(getState().pendingReferenceId).toBe('ann-full-chain');
    });
  });

  // ─── onCloseSearchModal ──────────────────────────────────────────────────────

  it('onCloseSearchModal closes the search modal', async () => {
    const { getState, getEventBus } = renderResolutionFlow();

    act(() => { getEventBus().get('resolve:search-requested').next({ referenceId: 'ref-close', searchTerm: 'test' }); });

    await waitFor(() => expect(getState().searchModalOpen).toBe(true));

    act(() => { getState().onCloseSearchModal(); });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(false);
    });
  });

  it('onCloseSearchModal does not clear pendingReferenceId (preserves for re-open)', async () => {
    const { getState, getEventBus } = renderResolutionFlow();

    act(() => { getEventBus().get('resolve:search-requested').next({ referenceId: 'ref-persist', searchTerm: 'test' }); });
    await waitFor(() => expect(getState().searchModalOpen).toBe(true));

    act(() => { getState().onCloseSearchModal(); });
    await waitFor(() => expect(getState().searchModalOpen).toBe(false));

    // pendingReferenceId remains — modal may reopen
    expect(getState().pendingReferenceId).toBe('ref-persist');
  });

  // ─── resolve:update-body ──────────────────────────────────────────────────

  it('resolve:update-body calls updateAnnotationBody API', async () => {
    const { getEventBus } = renderResolutionFlow();

    act(() => { getEventBus().get('resolve:update-body').next({
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-body-1',
      resourceId: 'linked-resource-id',
      operations: [{ op: 'add', item: { id: 'linked-resource-id' } }],
    }); });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalledTimes(1);
    });
  });

  it('resolve:update-body passes auth token to API call', async () => {
    const { getEventBus } = renderResolutionFlow();

    act(() => { getEventBus().get('resolve:update-body').next({
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-auth',
      resourceId: 'resource-id',
      operations: [{ op: 'replace', newItem: { id: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalled();
    });

    const callArgs = updateAnnotationBodySpy.mock.calls[0];
    expect(callArgs[2]).toHaveProperty('auth');
    expect(callArgs[2].auth).toBe(accessToken(testToken));
  });

  it('resolve:update-body emits resolve:body-updated on success', async () => {
    const { getEventBus } = renderResolutionFlow();
    const bodyUpdatedSpy = vi.fn();

    const subscription = getEventBus().get('resolve:body-updated').subscribe(bodyUpdatedSpy);

    act(() => { getEventBus().get('resolve:update-body').next({
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-success',
      resourceId: 'resource-id',
      operations: [{ op: 'add', item: { id: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(bodyUpdatedSpy).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();

    expect(bodyUpdatedSpy).toHaveBeenCalledWith({
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-success',
    });
  });

  it('resolve:update-body emits resolve:body-update-failed on API error', async () => {
    updateAnnotationBodySpy.mockRejectedValue(new Error('Update failed'));

    const { getEventBus } = renderResolutionFlow();
    const bodyUpdateFailedSpy = vi.fn();

    const subscription = getEventBus().get('resolve:body-update-failed').subscribe(bodyUpdateFailedSpy);

    act(() => { getEventBus().get('resolve:update-body').next({
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-fail',
      resourceId: 'resource-id',
      operations: [{ op: 'remove', item: { id: 'old-id' } }],
    }); });

    await waitFor(() => {
      expect(bodyUpdateFailedSpy).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();

    expect(bodyUpdateFailedSpy).toHaveBeenCalledWith({
      error: expect.any(Error),
    });
  });

  it('resolve:update-body called ONCE — no duplicate subscriptions', async () => {
    const { getEventBus } = renderResolutionFlow();

    act(() => { getEventBus().get('resolve:update-body').next({
      annotationUri: 'http://localhost:4000/resources/test-resource/annotations/ann-dedup',
      resourceId: 'resource-id',
      operations: [{ op: 'add', item: { id: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalledTimes(1);
    });
  });
});
