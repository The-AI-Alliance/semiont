/**
 * Layer 3: Feature Integration Test - Resolution Flow (search modal & body update)
 *
 * Tests the UNCOVERED half of useBindFlow:
 * - bind:link → emits bind:search-requested
 * - bind:search-requested → opens search modal with pendingReferenceId
 * - onCloseSearchModal → closes modal
 * - bind:update-body → calls updateAnnotationBody API
 * - bind:update-body → emits bind:body-updated on success
 * - bind:update-body → emits bind:body-update-failed on error
 * - auth token passed to updateAnnotationBody
 *
 * The deletion half of useBindFlow is covered by AnnotationDeletionIntegration.test.tsx.
 *
 * Uses real providers (EventBus, ApiClient, AuthToken) with mocked API boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useBindFlow } from '../../../hooks/useBindFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceId, accessToken, annotationId } from '@semiont/core';

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
  const testId = resourceId('test-resource');
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

  function renderBindFlow() {
    let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
    let lastState: ReturnType<typeof useBindFlow> | null = null;

    function TestComponent() {
      eventBusInstance = useEventBus();
      lastState = useBindFlow(testId);
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

  it('starts with both modals closed and no pending reference', () => {
    const { getState } = renderBindFlow();
    expect(getState().contextModalOpen).toBe(false);
    expect(getState().searchModalOpen).toBe(false);
    expect(getState().pendingReferenceId).toBeNull();
    expect(getState().pendingSearchTerm).toBeNull();
  });

  // ─── bind:link ─────────────────────────────────────────────────────────

  it('bind:link opens context modal and emits gather:requested', async () => {
    const { getState, getEventBus } = renderBindFlow();
    const gatherSpy = vi.fn();

    getEventBus().get('gather:requested').subscribe(gatherSpy);
    act(() => { getEventBus().get('bind:link').next({ annotationId: annotationId('ann-uri-123'), resourceId: resourceId('res-123'), searchTerm: 'climate change' }); });

    await waitFor(() => {
      expect(getState().contextModalOpen).toBe(true);
      expect(getState().pendingReferenceId).toBe('ann-uri-123');
      expect(getState().pendingSearchTerm).toBe('climate change');
    });

    expect(gatherSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        annotationId: annotationId('ann-uri-123'),
        resourceId: resourceId('res-123'),
      })
    );
  });

  // ─── bind:search-requested ────────────────────────────────────────────

  it('bind:search-requested opens the search modal', async () => {
    const { getState, getEventBus } = renderBindFlow();

    expect(getState().searchModalOpen).toBe(false);

    act(() => { getEventBus().get('bind:search-requested').next({ referenceId: 'ref-abc', searchTerm: 'oceans' }); });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
    });
  });

  it('bind:search-requested sets pendingReferenceId', async () => {
    const { getState, getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:search-requested').next({ referenceId: 'ref-xyz', searchTerm: 'forests' }); });

    await waitFor(() => {
      expect(getState().pendingReferenceId).toBe('ref-xyz');
    });
  });

  it('bind:link opens context modal (not search modal) end-to-end', async () => {
    const { getState, getEventBus } = renderBindFlow();

    // Simulate the full user journey: user clicks "Link Document" on a reference entry
    act(() => { getEventBus().get('bind:link').next({ annotationId: annotationId('ann-full-chain'), resourceId: resourceId('res-full'), searchTerm: 'biodiversity' }); });

    await waitFor(() => {
      expect(getState().contextModalOpen).toBe(true);
      expect(getState().pendingReferenceId).toBe('ann-full-chain');
      expect(getState().pendingSearchTerm).toBe('biodiversity');
    });

    // Search modal should NOT be open yet
    expect(getState().searchModalOpen).toBe(false);
  });

  // ─── onCloseSearchModal ──────────────────────────────────────────────────────

  it('onCloseSearchModal closes the search modal', async () => {
    const { getState, getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:search-requested').next({ referenceId: 'ref-close', searchTerm: 'test' }); });

    await waitFor(() => expect(getState().searchModalOpen).toBe(true));

    act(() => { getState().onCloseSearchModal(); });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(false);
    });
  });

  it('onCloseSearchModal does not clear pendingReferenceId (preserves for re-open)', async () => {
    const { getState, getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:search-requested').next({ referenceId: 'ref-persist', searchTerm: 'test' }); });
    await waitFor(() => expect(getState().searchModalOpen).toBe(true));

    act(() => { getState().onCloseSearchModal(); });
    await waitFor(() => expect(getState().searchModalOpen).toBe(false));

    // pendingReferenceId remains — modal may reopen
    expect(getState().pendingReferenceId).toBe('ref-persist');
  });

  // ─── bind:update-body ──────────────────────────────────────────────────

  it('bind:update-body calls updateAnnotationBody API', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:update-body').next({
      annotationId: annotationId('ann-body-1'),
      resourceId: resourceId('linked-resource-id'),
      operations: [{ op: 'add', item: { id: 'linked-resource-id' } }],
    }); });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalledTimes(1);
    });
  });

  it('bind:update-body passes auth token to API call', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:update-body').next({
      annotationId: annotationId('ann-auth'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'replace', newItem: { id: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalled();
    });

    const callArgs = updateAnnotationBodySpy.mock.calls[0];
    expect(callArgs[2]).toHaveProperty('auth');
    expect(callArgs[2].auth).toBe(accessToken(testToken));
  });

  it('bind:update-body emits bind:body-updated on success', async () => {
    const { getEventBus } = renderBindFlow();
    const bodyUpdatedSpy = vi.fn();

    const subscription = getEventBus().get('bind:body-updated').subscribe(bodyUpdatedSpy);

    act(() => { getEventBus().get('bind:update-body').next({
      annotationId: annotationId('ann-success'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'add', item: { id: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(bodyUpdatedSpy).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();

    expect(bodyUpdatedSpy).toHaveBeenCalledWith({
      annotationId: annotationId('ann-success'),
    });
  });

  it('bind:update-body emits bind:body-update-failed on API error', async () => {
    updateAnnotationBodySpy.mockRejectedValue(new Error('Update failed'));

    const { getEventBus } = renderBindFlow();
    const bodyUpdateFailedSpy = vi.fn();

    const subscription = getEventBus().get('bind:body-update-failed').subscribe(bodyUpdateFailedSpy);

    act(() => { getEventBus().get('bind:update-body').next({
      annotationId: annotationId('ann-fail'),
      resourceId: resourceId('resource-id'),
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

  it('bind:update-body called ONCE — no duplicate subscriptions', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:update-body').next({
      annotationId: annotationId('ann-dedup'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'add', item: { id: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(updateAnnotationBodySpy).toHaveBeenCalledTimes(1);
    });
  });
});
