/**
 * Tests for useBindFlow hook
 *
 * Validates the resolution capability:
 * - Event subscription to bind:link, bind:update-body
 * - Two-step flow: bind:link → context modal → bind:search-requested → search modal
 * - API calls with correct parameters
 * - Modal state management
 * - Success/failure event emission
 * - Toast notifications
 * - Body update operations (add, remove, replace)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { resourceUri, annotationId, resourceId } from '@semiont/core';
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
const mockUpdateAnnotationBody = vi.fn();

vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      updateAnnotationBody: mockUpdateAnnotationBody,
    }),
  };
});

// Test harness
function renderBindFlow() {
  const rUri = resourceUri('http://example.com/resources/resource-123');
  let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
  let lastState: ReturnType<typeof useBindFlow> | null = null;

  function TestComponent() {
    eventBusInstance = useEventBus();
    lastState = useBindFlow(rUri);
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
    getState: () => lastState!,
    getEventBus: () => eventBusInstance!,
  };
}

describe('useBindFlow', () => {
  const testAnnotationId = annotationId('anno-456');
  const testResourceId = resourceId('test-resource');

  beforeEach(() => {
    resetEventBusForTesting();
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
    mockShowInfo.mockClear();
    mockUpdateAnnotationBody.mockClear();
  });

  afterEach(() => {
    // Cleanup
  });

  it('has correct initial state', () => {
    const { getState } = renderBindFlow();

    expect(getState().contextModalOpen).toBe(false);
    expect(getState().searchModalOpen).toBe(false);
    expect(getState().pendingReferenceId).toBe(null);
    expect(getState().pendingSearchTerm).toBe(null);
    expect(getState().pendingResourceId).toBe(null);
  });

  // ─── Two-step flow: bind:link → context modal → search ─────────────

  it('opens context modal on bind:link event', async () => {
    const { getState, getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:link').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
        searchTerm: 'test search term',
      });
    });

    await waitFor(() => {
      expect(getState().contextModalOpen).toBe(true);
      expect(getState().pendingReferenceId).toBe(String(testAnnotationId));
      expect(getState().pendingSearchTerm).toBe('test search term');
      expect(getState().pendingResourceId).toBe(testResourceId);
    });

    // Search modal should NOT be open yet (two-step flow)
    expect(getState().searchModalOpen).toBe(false);
  });

  it('emits gather:requested on bind:link', async () => {
    const { getEventBus } = renderBindFlow();
    const gatherSpy = vi.fn();
    getEventBus().get('gather:requested').subscribe(gatherSpy);

    act(() => {
      getEventBus().get('bind:link').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
        searchTerm: 'test',
      });
    });

    await waitFor(() => {
      expect(gatherSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          annotationId: testAnnotationId,
          resourceId: testResourceId,
        })
      );
    });
  });

  it('does NOT emit bind:search-requested immediately on bind:link', async () => {
    const { getEventBus } = renderBindFlow();
    const searchRequestedSpy = vi.fn();
    getEventBus().get('bind:search-requested').subscribe(searchRequestedSpy);

    act(() => {
      getEventBus().get('bind:link').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
        searchTerm: 'test',
      });
    });

    // Give time for any async processing
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(searchRequestedSpy).not.toHaveBeenCalled();
  });

  it('closes context modal via onCloseContextModal', async () => {
    const { getState, getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:link').next({
        annotationId: testAnnotationId,
        resourceId: testResourceId,
        searchTerm: 'test',
      });
    });

    await waitFor(() => {
      expect(getState().contextModalOpen).toBe(true);
    });

    act(() => {
      getState().onCloseContextModal();
    });

    await waitFor(() => {
      expect(getState().contextModalOpen).toBe(false);
    });
  });

  // ─── bind:search-requested → search modal ──────────────────────────

  it('opens search modal on bind:search-requested', async () => {
    const { getState, getEventBus } = renderBindFlow();

    expect(getState().searchModalOpen).toBe(false);

    act(() => {
      getEventBus().get('bind:search-requested').next({
        referenceId: testAnnotationId,
        searchTerm: 'test search',
      });
    });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
      expect(getState().pendingReferenceId).toBe(testAnnotationId);
    });
  });

  it('closes search modal when onCloseSearchModal is called', async () => {
    const { getState, getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:search-requested').next({
        referenceId: testAnnotationId,
        searchTerm: 'test',
      });
    });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
    });

    act(() => {
      getState().onCloseSearchModal();
    });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(false);
    });
  });

  // ─── Body update operations ─────────────────────────────────────────

  it('handles body update with add operation', async () => {
    mockUpdateAnnotationBody.mockResolvedValue(undefined);

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
      expect(mockUpdateAnnotationBody).toHaveBeenCalled();
    });
  });

  it('handles body update with remove operation', async () => {
    mockUpdateAnnotationBody.mockResolvedValue(undefined);

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
      expect(mockUpdateAnnotationBody).toHaveBeenCalled();
    });
  });

  it('handles body update with replace operation', async () => {
    mockUpdateAnnotationBody.mockResolvedValue(undefined);

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
      expect(mockUpdateAnnotationBody).toHaveBeenCalled();
    });
  });

  it('emits bind:body-updated on successful update', async () => {
    mockUpdateAnnotationBody.mockResolvedValue(undefined);

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
    mockUpdateAnnotationBody.mockRejectedValue(testError);

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
    mockUpdateAnnotationBody.mockRejectedValue(testError);

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
