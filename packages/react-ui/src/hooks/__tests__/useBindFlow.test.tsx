/**
 * Tests for useBindFlow hook
 *
 * Validates the React-layer of the bind flow:
 * - Bridges bind:update-body EventBus events to client.bind.body()
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

const { mockBindBody, mockShowSuccess, mockShowError, mockShowInfo } = vi.hoisted(() => {
  return {
    mockBindBody: vi.fn(),
    mockShowSuccess: vi.fn(),
    mockShowError: vi.fn(),
    mockShowInfo: vi.fn(),
  };
});

// Mock API client — useBindFlow calls client.bind.body()
vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      bind: { body: mockBindBody },
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
    mockBindBody.mockClear();

    mockBindBody.mockResolvedValue(undefined);
  });

  it('calls client.bind.body when bind:update-body event is emitted', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: 'anno-1',
        operations: [{ op: 'replace', path: '/value', value: 'new-value' }],
      });
    });

    await waitFor(() => {
      expect(mockBindBody).toHaveBeenCalled();
    });
  });

  it('shows error toast on bind:body-update-failed', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:body-update-failed').next({ message: 'Failed to link reference' });
    });

    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update reference')
      );
    });
  });

  it('shows error toast when client.bind.body rejects', async () => {
    mockBindBody.mockRejectedValue(new Error('Network error'));
    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('bind:update-body').next({
        annotationId: 'anno-1',
        operations: [{ op: 'replace', path: '/value', value: 'x' }],
      });
    });

    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.stringContaining('Network error')
      );
    });
  });
});
