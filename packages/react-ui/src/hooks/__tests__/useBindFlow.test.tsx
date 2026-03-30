/**
 * Tests for useBindFlow hook
 *
 * Validates the write side of reference resolution:
 * - Event subscription to bind:update-body
 * - API calls with correct parameters
 * - Success/failure event emission
 * - Toast notifications
 * - Body update operations (add, remove, replace)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { annotationId, resourceId } from '@semiont/core';
import { useBindFlow } from '../useBindFlow';

// Mock the toast hook to track calls
vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showInfo: mockShowInfo,
    showWarning: vi.fn(),
  }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { mockBindAnnotation, mockShowSuccess, mockShowError, mockShowInfo } = vi.hoisted(() => {
  return {
    mockBindAnnotation: vi.fn(),
    mockShowSuccess: vi.fn(),
    mockShowError: vi.fn(),
    mockShowInfo: vi.fn(),
  };
});

// Mock API client — useBindFlow calls client.sse.bindAnnotation (SSEClient)
vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      sse: { bindAnnotation: mockBindAnnotation },
    }),
  };
});

// Test harness
function renderBindFlow() {
  const rId = resourceId('resource-123');
  let eventBusInstance: ReturnType<typeof useEventBus> | null = null;

  function TestComponent() {
    eventBusInstance = useEventBus();
    useBindFlow(rId);
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
    getEventBus: () => eventBusInstance!,
  };
}

describe('useBindFlow', () => {
  const testAnnotationId = annotationId('anno-456');

  beforeEach(() => {
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
    mockShowInfo.mockClear();
    mockBindAnnotation.mockClear();

    // Default: emit bind:finished on success
    mockBindAnnotation.mockImplementation((_rId: any, annId: any, _req: any, opts: any) => {
      queueMicrotask(() => opts.eventBus.get('bind:finished').next({ annotationId: annId }));
      return { close: vi.fn() };
    });
  });

  afterEach(() => {
    // Cleanup
  });

  // ─── Body update operations ─────────────────────────────────────────

  it('handles body update with add operation', async () => {
    const { getEventBus } = renderBindFlow();

    const newBodyItem = {
      type: 'SpecificResource' as const,
      source: 'resource:789',
    };

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'add',
            item: newBodyItem,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(mockBindAnnotation).toHaveBeenCalled();
    });
  });

  it('handles body update with remove operation', async () => {
    const { getEventBus } = renderBindFlow();

    const oldBodyItem = {
      type: 'SpecificResource' as const,
      source: 'resource:789',
    };

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'remove',
            item: oldBodyItem,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(mockBindAnnotation).toHaveBeenCalled();
    });
  });

  it('handles body update with replace operation', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'replace',
            oldItem: { type: 'SpecificResource' as const, source: 'resource:123' },
            newItem: { type: 'SpecificResource' as const, source: 'resource:789' },
          },
        ],
      });
    });

    await waitFor(() => {
      expect(mockBindAnnotation).toHaveBeenCalled();
    });
  });

  it('emits bind:body-updated on successful update', async () => {
    const { getEventBus } = renderBindFlow();

    const bodyUpdatedSpy = vi.fn();
    getEventBus().get('bind:body-updated').subscribe(bodyUpdatedSpy);

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'add',
            item: { type: 'SpecificResource' as const, source: 'resource:789' },
          },
        ],
      });
    });

    await waitFor(() => {
      expect(bodyUpdatedSpy).toHaveBeenCalledWith({
        annotationId: testAnnotationId,
      });
    });
  });

  it('emits bind:body-update-failed on API error', async () => {
    const testError = new Error('Network error');

    mockBindAnnotation.mockImplementation((_rId: any, _annId: any, _req: any, opts: any) => {
      queueMicrotask(() => opts.eventBus.get('bind:failed').next({ error: testError }));
      return { close: vi.fn() };
    });

    const { getEventBus } = renderBindFlow();

    const bodyUpdateFailedSpy = vi.fn();
    getEventBus().get('bind:body-update-failed').subscribe(bodyUpdateFailedSpy);

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'add',
            item: { type: 'SpecificResource' as const, source: 'resource:789' },
          },
        ],
      });
    });

    await waitFor(() => {
      expect(bodyUpdateFailedSpy).toHaveBeenCalledWith({
        error: testError,
      });
    });
  });

  it('shows error toast on body update failure', async () => {
    const testError = new Error('Failed to link reference');

    mockBindAnnotation.mockImplementation((_rId: any, _annId: any, _req: any, opts: any) => {
      queueMicrotask(() => opts.eventBus.get('bind:failed').next({ error: testError }));
      return { close: vi.fn() };
    });

    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'add',
            item: { type: 'SpecificResource' as const, source: 'resource:789' },
          },
        ],
      });
    });

    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update reference')
      );
    });
  });
});
