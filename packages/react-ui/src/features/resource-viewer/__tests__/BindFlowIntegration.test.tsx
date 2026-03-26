/**
 * Layer 3: Feature Integration Test - Bind Flow (body update)
 *
 * Tests the write side of useBindFlow:
 * - bind:update-body → calls bindAnnotation API
 * - bind:update-body → emits bind:body-updated on success
 * - bind:update-body → emits bind:body-update-failed on error
 * - auth token passed to bindAnnotation
 *
 * The wizard modal (ReferenceWizardModal) handles modal state, context
 * gathering, search configuration, and result display. This test covers
 * only the downstream API calls after the wizard emits bind:update-body.
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
import { SSEClient } from '@semiont/api-client';
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

describe('Bind Flow - Body Update Integration', () => {
  let bindAnnotationSpy: ReturnType<typeof vi.fn>;
  const testId = resourceId('test-resource');
  const testToken = 'test-resolution-token';
  const testBaseUrl = 'http://localhost:4000';

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    bindAnnotationSpy = vi.fn().mockImplementation((_rId: any, annId: any, _req: any, opts: any) => {
      queueMicrotask(() => opts.eventBus.get('bind:finished').next({ annotationId: annId }));
      return { close: vi.fn() };
    });
    vi.spyOn(SSEClient.prototype, 'bindAnnotation').mockImplementation(bindAnnotationSpy as any);
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

  it('bind:update-body calls bindAnnotation API', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => { getEventBus().get('bind:update-body').next({
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
      annotationId: annotationId('ann-auth'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'replace', newItem: { type: 'SpecificResource' as const, source: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(bindAnnotationSpy).toHaveBeenCalled();
    });

    const callArgs = bindAnnotationSpy.mock.calls[0];
    expect(callArgs[3]).toHaveProperty('auth');
    expect(callArgs[3].auth).toBe(accessToken(testToken));
  });

  it('bind:update-body emits bind:body-updated on success', async () => {
    const { getEventBus } = renderBindFlow();
    const bodyUpdatedSpy = vi.fn();

    const subscription = getEventBus().get('bind:body-updated').subscribe(bodyUpdatedSpy);

    act(() => { getEventBus().get('bind:update-body').next({
      annotationId: annotationId('ann-success'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'add', item: { type: 'SpecificResource' as const, source: 'resource-id' } }],
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
    bindAnnotationSpy.mockImplementation((_rId: any, _annId: any, _req: any, opts: any) => {
      queueMicrotask(() => opts.eventBus.get('bind:failed').next({ error: new Error('Update failed') }));
      return { close: vi.fn() };
    });

    const { getEventBus } = renderBindFlow();
    const bodyUpdateFailedSpy = vi.fn();

    const subscription = getEventBus().get('bind:body-update-failed').subscribe(bodyUpdateFailedSpy);

    act(() => { getEventBus().get('bind:update-body').next({
      annotationId: annotationId('ann-fail'),
      resourceId: resourceId('resource-id'),
      operations: [{ op: 'remove', item: { type: 'SpecificResource' as const, source: 'old-id' } }],
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
      operations: [{ op: 'add', item: { type: 'SpecificResource' as const, source: 'resource-id' } }],
    }); });

    await waitFor(() => {
      expect(bindAnnotationSpy).toHaveBeenCalledTimes(1);
    });
  });
});
