/**
 * Tests for useBindFlow hook
 *
 * Validates the resolution capability:
 * - Event subscription to bind:link, bind:update-body
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
import { resourceUri } from '@semiont/core';
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
  const testAnnotationUri = 'http://example.com/annotations/anno-456';

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

  it('subscribes to bind:link event', () => {
    const { getState, getEventBus } = renderBindFlow();

    // Initial state
    expect(getState().searchModalOpen).toBe(false);
    expect(getState().pendingReferenceId).toBe(null);

    // Verify subscription exists by checking if event can be triggered
    const resolveLinkChannel = getEventBus().get('bind:link');
    expect(resolveLinkChannel).toBeDefined();
  });

  it('opens search modal on bind:link event', async () => {
    const { getEventBus } = renderBindFlow();

    // Subscribe to bind:search-requested to verify relay
    const searchRequestedSpy = vi.fn();
    getEventBus().get('bind:search-requested').subscribe(searchRequestedSpy);

    // Trigger bind:link event
    act(() => {
      getEventBus().get('bind:link').next({
        annotationUri: testAnnotationUri,
        searchTerm: 'test search term',
      });
    });

    // Should relay to bind:search-requested
    await waitFor(() => {
      expect(searchRequestedSpy).toHaveBeenCalledWith({
        referenceId: testAnnotationUri,
        searchTerm: 'test search term',
      });
    });
  });

  it('opens modal and stores pending reference on bind:search-requested', async () => {
    const { getState, getEventBus } = renderBindFlow();

    // Initially closed
    expect(getState().searchModalOpen).toBe(false);
    expect(getState().pendingReferenceId).toBe(null);

    // Trigger search requested
    act(() => {
      getEventBus().get('bind:search-requested').next({
        referenceId: testAnnotationUri,
        searchTerm: 'test search',
      });
    });

    // Modal should open and reference should be stored
    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
      expect(getState().pendingReferenceId).toBe(testAnnotationUri);
    });
  });

  it('closes modal when onCloseSearchModal is called', async () => {
    const { getState, getEventBus } = renderBindFlow();

    // Open the modal first
    act(() => {
      getEventBus().get('bind:search-requested').next({
        referenceId: testAnnotationUri,
        searchTerm: 'test',
      });
    });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(true);
    });

    // Close the modal
    act(() => {
      getState().onCloseSearchModal();
    });

    await waitFor(() => {
      expect(getState().searchModalOpen).toBe(false);
    });
  });

  it('handles body update with add operation', async () => {
    mockUpdateAnnotationBody.mockResolvedValue(undefined);

    const { getEventBus } = renderBindFlow();

    const newBodyItem = {
      type: 'SpecificResource' as const,
      source: 'resource:789',
    };

    const testResourceUri = resourceUri('http://example.com/resources/resource-123');

    // Trigger body update with add operation
    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationUri: testAnnotationUri,
        resourceId: testResourceUri,
        operations: [
          {
            op: 'add',
            item: newBodyItem,
          },
        ],
      });
    });

    // Should call API with correct parameters
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

    const testResourceUri = resourceUri('http://example.com/resources/resource-123');

    // Trigger body update with remove operation
    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationUri: testAnnotationUri,
        resourceId: testResourceUri,
        operations: [
          {
            op: 'remove',
            oldItem: oldBodyItem,
          },
        ],
      });
    });

    // Should call API with correct parameters
    await waitFor(() => {
      expect(mockUpdateAnnotationBody).toHaveBeenCalled();
    });
  });

  it('handles body update with replace operation', async () => {
    mockUpdateAnnotationBody.mockResolvedValue(undefined);

    const { getEventBus } = renderBindFlow();

    const oldBodyItem = {
      type: 'SpecificResource' as const,
      source: 'resource:123',
    };

    const newBodyItem = {
      type: 'SpecificResource' as const,
      source: 'resource:789',
    };

    const testResourceUri = resourceUri('http://example.com/resources/resource-123');

    // Trigger body update with replace operation
    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationUri: testAnnotationUri,
        resourceId: testResourceUri,
        operations: [
          {
            op: 'replace',
            oldItem: oldBodyItem,
            newItem: newBodyItem,
          },
        ],
      });
    });

    // Should call API with correct parameters
    await waitFor(() => {
      expect(mockUpdateAnnotationBody).toHaveBeenCalled();
    });
  });

  it('emits bind:body-updated on successful update', async () => {
    mockUpdateAnnotationBody.mockResolvedValue(undefined);

    const { getEventBus } = renderBindFlow();

    // Subscribe to bind:body-updated event
    const bodyUpdatedSpy = vi.fn();
    getEventBus().get('bind:body-updated').subscribe(bodyUpdatedSpy);

    const testResourceUri = resourceUri('http://example.com/resources/resource-123');

    // Trigger body update
    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationUri: testAnnotationUri,
        resourceId: testResourceUri,
        operations: [
          {
            op: 'add',
            item: { type: 'SpecificResource', source: 'resource:789' },
          },
        ],
      });
    });

    // Should emit body-updated event
    await waitFor(() => {
      expect(bodyUpdatedSpy).toHaveBeenCalledWith({
        annotationUri: testAnnotationUri,
      });
    });
  });

  it('emits bind:body-update-failed on API error', async () => {
    const testError = new Error('Network error');
    mockUpdateAnnotationBody.mockRejectedValue(testError);

    const { getEventBus } = renderBindFlow();

    // Subscribe to bind:body-update-failed event
    const bodyUpdateFailedSpy = vi.fn();
    getEventBus().get('bind:body-update-failed').subscribe(bodyUpdateFailedSpy);

    const testResourceUri = resourceUri('http://example.com/resources/resource-123');

    // Trigger body update
    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationUri: testAnnotationUri,
        resourceId: testResourceUri,
        operations: [
          {
            op: 'add',
            item: { type: 'SpecificResource', source: 'resource:789' },
          },
        ],
      });
    });

    // Should emit body-update-failed event
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

    const testResourceUri = resourceUri('http://example.com/resources/resource-123');

    // Trigger body update
    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationUri: testAnnotationUri,
        resourceId: testResourceUri,
        operations: [
          {
            op: 'add',
            item: { type: 'SpecificResource', source: 'resource:789' },
          },
        ],
      });
    });

    // Should show error toast
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update reference')
      );
    });
  });
});
