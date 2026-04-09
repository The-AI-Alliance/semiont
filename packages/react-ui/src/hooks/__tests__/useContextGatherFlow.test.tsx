/**
 * Tests for useContextGatherFlow hook
 *
 * Validates the React-layer of the gather flow:
 * - Delegates to client.flows.gatherContext() on mount
 * - Updates UI state in response to gather:requested / gather:complete / gather:failed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { annotationId, resourceId } from '@semiont/core';
import { useContextGatherFlow, type ContextGatherFlowState } from '../useContextGatherFlow';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';

vi.mock('../../components/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn(), showWarning: vi.fn() }),
}));

const mockGatherContext = vi.fn();

vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      flows: { gatherContext: mockGatherContext },
    }),
  };
});

const testResourceId = resourceId('resource-123');
const testAnnotationId = annotationId('anno-456');

const mockAnnotationContext = {
  annotation: {},
  sourceResource: {},
  sourceContext: { before: 'before', selected: 'selected', after: 'after' },
};

function renderFlow() {
  let state: ContextGatherFlowState | null = null;
  let eventBusInstance: ReturnType<typeof useEventBus> | null = null;

  function TestComponent() {
    eventBusInstance = useEventBus();
    state = useContextGatherFlow({ resourceId: testResourceId });
    return null;
  }

  render(
    <EventBusProvider>
      <AuthTokenProvider token="test-token-123">
        <ApiClientProvider baseUrl="http://localhost:4000">
          <TestComponent />
        </ApiClientProvider>
      </AuthTokenProvider>
    </EventBusProvider>
  );

  return {
    getState: () => state!,
    getEventBus: () => eventBusInstance!,
  };
}

describe('useContextGatherFlow', () => {
  beforeEach(() => {
    mockGatherContext.mockClear();
    mockGatherContext.mockReturnValue({ unsubscribe: vi.fn() });
  });

  it('initial state is idle', () => {
    const { getState } = renderFlow();
    expect(getState().gatherLoading).toBe(false);
    expect(getState().gatherContext).toBe(null);
    expect(getState().gatherError).toBe(null);
    expect(getState().gatherAnnotationId).toBe(null);
  });

  it('calls client.flows.gatherContext on mount', async () => {
    renderFlow();
    await waitFor(() => expect(mockGatherContext).toHaveBeenCalled());
  });

  it('sets loading state on gather:requested', async () => {
    const { getState, getEventBus } = renderFlow();

    act(() => {
      getEventBus().get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    await waitFor(() => {
      expect(getState().gatherLoading).toBe(true);
      expect(getState().gatherAnnotationId).toBe(testAnnotationId);
    });
  });

  it('stores gatherAnnotationId after request', async () => {
    const { getState, getEventBus } = renderFlow();

    act(() => {
      getEventBus().get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    await waitFor(() => {
      expect(getState().gatherAnnotationId).toBe(testAnnotationId);
    });
  });

  it('updates context on gather:complete', async () => {
    const { getState, getEventBus } = renderFlow();

    act(() => {
      getEventBus().get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    act(() => {
      getEventBus().get('gather:complete').next({
        annotationId: testAnnotationId,
        response: { context: mockAnnotationContext as any },
      });
    });

    await waitFor(() => {
      expect(getState().gatherLoading).toBe(false);
      expect(getState().gatherContext).toEqual(mockAnnotationContext);
    });
  });

  it('sets error state on gather:failed', async () => {
    const { getState, getEventBus } = renderFlow();

    act(() => {
      getEventBus().get('gather:requested').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    act(() => {
      getEventBus().get('gather:failed').next({ annotationId: testAnnotationId, message: 'Gather failed' } as any);
    });

    await waitFor(() => {
      expect(getState().gatherError).toEqual(new Error('Gather failed'));
      expect(getState().gatherLoading).toBe(false);
    });
  });

  it('clears state on new request before resolving', async () => {
    const { getState, getEventBus } = renderFlow();

    // First request completes
    act(() => {
      getEventBus().get('gather:requested').next({ annotationId: testAnnotationId, resourceId: testResourceId });
    });
    act(() => {
      getEventBus().get('gather:complete').next({ annotationId: testAnnotationId, response: { context: mockAnnotationContext as any } });
    });

    await waitFor(() => expect(getState().gatherContext).not.toBe(null));

    // Second request — stays loading
    act(() => {
      getEventBus().get('gather:requested').next({ annotationId: annotationId('anno-789'), resourceId: testResourceId });
    });

    await waitFor(() => {
      expect(getState().gatherContext).toBe(null);
      expect(getState().gatherLoading).toBe(true);
    });
  });
});
