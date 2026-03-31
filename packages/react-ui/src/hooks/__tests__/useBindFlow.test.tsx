/**
 * Tests for useBindFlow hook
 *
 * Validates the React-layer of the bind flow:
 * - Delegates to client.flows.bind() on mount
 * - Shows error toast on bind:body-update-failed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { resourceId } from '@semiont/core';
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

const { mockBind, mockUnsubscribe, mockShowSuccess, mockShowError, mockShowInfo } = vi.hoisted(() => {
  return {
    mockBind: vi.fn(),
    mockUnsubscribe: vi.fn(),
    mockShowSuccess: vi.fn(),
    mockShowError: vi.fn(),
    mockShowInfo: vi.fn(),
  };
});

// Mock API client — useBindFlow calls client.flows.bind()
vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      flows: { bind: mockBind },
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
  beforeEach(() => {
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
    mockShowInfo.mockClear();
    mockBind.mockClear();
    mockUnsubscribe.mockClear();

    mockBind.mockReturnValue({ unsubscribe: mockUnsubscribe });
  });

  it('calls client.flows.bind on mount', async () => {
    renderBindFlow();

    await waitFor(() => {
      expect(mockBind).toHaveBeenCalled();
    });
  });

  it('shows error toast on bind:body-update-failed', async () => {
    const { getEventBus } = renderBindFlow();
    const testError = new Error('Failed to link reference');

    act(() => {
      getEventBus().get('bind:body-update-failed').next({ error: testError });
    });

    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update reference')
      );
    });
  });

  it('unsubscribes on unmount', async () => {
    function TestComponent() {
      useBindFlow(resourceId('resource-123'));
      return null;
    }
    const { unmount } = render(
      <EventBusProvider>
        <AuthTokenProvider token="test-token-123">
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestComponent />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    await waitFor(() => expect(mockBind).toHaveBeenCalled());
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
