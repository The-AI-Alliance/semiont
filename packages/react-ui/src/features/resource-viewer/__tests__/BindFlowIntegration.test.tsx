/**
 * Layer 3: Feature Integration Test - Bind Flow (body update)
 *
 * Tests the write side of useBindFlow:
 * - bind:update-body → calls http.bindAnnotation API (plain POST)
 * - bind:update-body → emits bind:body-update-failed on error
 * - auth token passed to bindAnnotation
 *
 * After the UNIFIED-STREAM migration, bind is a plain POST returning
 * {correlationId}. The state change arrives on the events-stream as
 * mark:body-updated. These tests focus on the POST call, not the
 * events-stream delivery (which is tested in AnnotationStore tests).
 *
 * Uses real providers (EventBus, ApiClient, AuthToken) with mocked API boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useBindFlow } from '../../../hooks/useBindFlow';
import { EventBusProvider, useEventBus } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceId, annotationId } from '@semiont/core';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

describe('Bind Flow - Body Update Integration', () => {
  let bindAnnotationSpy: ReturnType<typeof vi.fn>;
  const testId = resourceId('test-resource');
  const testToken = 'test-resolution-token';
  const testBaseUrl = 'http://localhost:4000';

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock the HTTP bindAnnotation method (plain POST, returns {correlationId})
    bindAnnotationSpy = vi.fn().mockResolvedValue({ correlationId: 'corr-test' });
    vi.spyOn(SemiontApiClient.prototype, 'bindAnnotation').mockImplementation(bindAnnotationSpy as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Render helper ──────────────────────────────────────────────────────────

  function renderBindFlow() {
    let eventBusInstance: ReturnType<typeof useEventBus> | null = null;

    function TestComponent() {
      eventBusInstance = useEventBus();
      useBindFlow(testId);
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
      getEventBus: () => eventBusInstance!,
    };
  }

  // ─── bind:update-body ──────────────────────────────────────────────────

  it('bind:update-body calls http.bindAnnotation (plain POST)', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:update-body').next({
      correlationId: 'corr-1',
      annotationId: annotationId('ann-body-1'),
      resourceId: resourceId('linked-resource-id'),
      operations: [{ op: 'add', item: { type: 'SpecificResource' as const, source: 'linked-resource-id' } }],
    }); });

    await waitFor(() => {
      expect(bindAnnotationSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('bind:update-body passes auth token to API call', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:update-body').next({
      correlationId: 'corr-2',
      annotationId: annotationId('ann-auth'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'replace', newItem: { type: 'SpecificResource' as const, source: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(bindAnnotationSpy).toHaveBeenCalled();
    });

    const callArgs = bindAnnotationSpy.mock.calls[0];
    expect(callArgs[3]).toHaveProperty('auth');
  });

  it('bind:update-body emits bind:body-update-failed on API error', async () => {
    bindAnnotationSpy.mockRejectedValueOnce(new Error('Update failed'));

    const { getEventBus } = renderBindFlow();
    const bodyUpdateFailedSpy = vi.fn();

    const subscription = getEventBus().get('bind:body-update-failed').subscribe(bodyUpdateFailedSpy);

    act(() => { getEventBus().get('bind:update-body').next({
      correlationId: 'corr-3',
      annotationId: annotationId('ann-fail'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'remove', item: { type: 'SpecificResource' as const, source: 'old-id' } }],
    }); });

    await waitFor(() => {
      expect(bodyUpdateFailedSpy).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();

    expect(bodyUpdateFailedSpy).toHaveBeenCalledWith({
      message: expect.any(String),
    });
  });

  it('bind:update-body called ONCE — no duplicate subscriptions', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:update-body').next({
      correlationId: 'corr-4',
      annotationId: annotationId('ann-dedup'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'add', item: { type: 'SpecificResource' as const, source: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(bindAnnotationSpy).toHaveBeenCalledTimes(1);
    });
  });
});
