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
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { annotationId, resourceId } from '@semiont/core';
import { useBindFlow } from '../useBindFlow';

// Mock the toast hook to track calls
const mockShowSuccess = vi.fn();
const mockShowError = vi.fn();
const mockShowInfo = vi.fn();

vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showInfo: mockShowInfo,
    showWarning: vi.fn(),
  }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock API client
const mockBindAnnotation = vi.fn();

vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      bindAnnotation: mockBindAnnotation,
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
    resetEventBusForTesting();
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
    mockShowInfo.mockClear();
    mockBindAnnotation.mockClear();
  });

  afterEach(() => {
    // Cleanup
  });

  // ─── Body update operations ─────────────────────────────────────────

  it('handles body update with add operation', async () => {
    mockBindAnnotation.mockResolvedValue(undefined);

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
    mockBindAnnotation.mockResolvedValue(undefined);

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
            oldItem: oldBodyItem,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(mockBindAnnotation).toHaveBeenCalled();
    });
  });

  it('handles body update with replace operation', async () => {
    mockBindAnnotation.mockResolvedValue(undefined);

    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'replace',
            oldItem: { type: 'SpecificResource', source: 'resource:123' },
            newItem: { type: 'SpecificResource', source: 'resource:789' },
          },
        ],
      });
    });

    await waitFor(() => {
      expect(mockBindAnnotation).toHaveBeenCalled();
    });
  });

  it('emits bind:body-updated on successful update', async () => {
    mockBindAnnotation.mockResolvedValue(undefined);

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
            item: { type: 'SpecificResource', source: 'resource:789' },
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
    mockBindAnnotation.mockRejectedValue(testError);

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
            item: { type: 'SpecificResource', source: 'resource:789' },
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
    mockBindAnnotation.mockRejectedValue(testError);

    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: testAnnotationId,
        resourceId: resourceId('resource-123'),
        operations: [
          {
            op: 'add',
            item: { type: 'SpecificResource', source: 'resource:789' },
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
