/**
 * Tests for useContextGatherFlow hook
 *
 * Validates the gather capability:
 * - Event subscription to gather:requested
 * - API calls with correct parameters
 * - Success/failure event emission
 * - State management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { EventBus, annotationId, resourceId } from '@semiont/core';
import { SSEClient } from '@semiont/api-client';
import { useContextGatherFlow, type ContextGatherFlowState } from '../useContextGatherFlow';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { ApiClientProvider, useApiClient } from '../../contexts/ApiClientContext';

// Mock Toast to avoid provider errors
vi.mock('../../components/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn(), showWarning: vi.fn() }),
}));

describe('useContextGatherFlow', () => {
  let eventBus: EventBus;
  let gatherAnnotationSpy: ReturnType<typeof vi.fn>;
  const testToken = 'test-token-123';
  const testResourceId = resourceId('resource-123');
  const testAnnotationId = annotationId('anno-456');
  const testBaseUrl = 'http://localhost:4000';

  const mockAnnotationContext = {
    annotation: {},
    sourceResource: {},
    sourceContext: { before: 'before', selected: 'selected', after: 'after' },
  };

  beforeEach(() => {
    eventBus = new EventBus();

    gatherAnnotationSpy = vi.fn().mockImplementation(
      (_rid: any, aid: any, _req: any, opts: any) => {
        queueMicrotask(() =>
          opts.eventBus.get('gather:annotation-finished').next({
            annotationId: aid,
            response: { context: mockAnnotationContext },
          })
        );
      }
    );
    vi.spyOn(SSEClient.prototype, 'gatherAnnotation').mockImplementation(gatherAnnotationSpy as any);
  });

  afterEach(() => {
    eventBus.destroy();
    vi.restoreAllMocks();
  });

  // ─── Render helper ───────────────────────────────────────────────────────────

  function renderFlow() {
    let state: ContextGatherFlowState | null = null;

    function TestComponent() {
      const client = useApiClient();
      state = useContextGatherFlow(eventBus, { client, resourceId: testResourceId });
      return null;
    }

    render(
      <AuthTokenProvider token={testToken}>
        <ApiClientProvider baseUrl={testBaseUrl}>
          <TestComponent />
        </ApiClientProvider>
      </AuthTokenProvider>
    );

    return { getState: () => state! };
  }

  // ─── Tests ───────────────────────────────────────────────────────────────────

  it('initial state is idle', () => {
    const { getState } = renderFlow();
    expect(getState().gatherLoading).toBe(false);
    expect(getState().gatherContext).toBe(null);
    expect(getState().gatherError).toBe(null);
    expect(getState().gatherAnnotationId).toBe(null);
  });

  it('calls gatherAnnotation API on gather:requested', async () => {
    renderFlow();

    act(() => {
      eventBus.get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    await waitFor(() => {
      expect(gatherAnnotationSpy).toHaveBeenCalledWith(
        testResourceId,
        testAnnotationId,
        expect.objectContaining({ contextWindow: expect.any(Number) }),
        expect.objectContaining({ eventBus })
      );
    });
  });

  it('emits gather:complete on success', async () => {
    renderFlow();

    const completeSpy = vi.fn();
    eventBus.get('gather:complete').subscribe(completeSpy);

    act(() => {
      eventBus.get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    await waitFor(() => {
      expect(completeSpy).toHaveBeenCalledWith({
        annotationId: testAnnotationId,
        response: { context: mockAnnotationContext },
      });
    });
  });

  it('stores gatherAnnotationId after request', async () => {
    const { getState } = renderFlow();

    act(() => {
      eventBus.get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    await waitFor(() => {
      expect(getState().gatherAnnotationId).toBe(testAnnotationId);
    });
  });

  it('sets error state on gather:failed', async () => {
    const testError = new Error('Gather failed');
    gatherAnnotationSpy.mockImplementation((_rid: any, aid: any, _req: any, opts: any) => {
      queueMicrotask(() =>
        opts.eventBus.get('gather:failed').next({ annotationId: aid, error: testError })
      );
    });

    const { getState } = renderFlow();

    act(() => {
      eventBus.get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    await waitFor(() => {
      expect(getState().gatherError).toBe(testError);
      expect(getState().gatherLoading).toBe(false);
    });
  });

  it('clears state on new request before resolving', async () => {
    const { getState } = renderFlow();

    // First request completes
    act(() => {
      eventBus.get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    await waitFor(() => expect(getState().gatherContext).not.toBe(null));

    // Second request — spy doesn't emit, stays loading
    gatherAnnotationSpy.mockImplementation(() => {});

    act(() => {
      eventBus.get('gather:requested').next({
        annotationId: annotationId('anno-789'),
        resourceId: testResourceId,
      });
    });

    await waitFor(() => {
      expect(getState().gatherContext).toBe(null);
      expect(getState().gatherLoading).toBe(true);
    });
  });
});
