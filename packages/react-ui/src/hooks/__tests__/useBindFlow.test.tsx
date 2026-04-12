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

const { mockBindBody, mockMatchSearch, mockShowSuccess, mockShowError, mockShowInfo } = vi.hoisted(() => {
  return {
    mockBindBody: vi.fn(),
    mockMatchSearch: vi.fn(),
    mockShowSuccess: vi.fn(),
    mockShowError: vi.fn(),
    mockShowInfo: vi.fn(),
  };
});

// Mock API client — useBindFlow calls semiont.bind.body() and semiont.match.search().
// Stable reference: useApiClient is called per render. The real provider holds
// one instance; the mock must do the same to keep useMemo deps stable.
const stableMockClient = {
  bind: { body: mockBindBody },
  match: { search: mockMatchSearch },
};

vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => stableMockClient,
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
    mockMatchSearch.mockClear();

    mockBindBody.mockResolvedValue(undefined);
    // match.search returns an Observable — mock with subscribe
    mockMatchSearch.mockReturnValue({
      subscribe: vi.fn(({ next, complete }) => {
        next?.({ correlationId: 'c1', referenceId: 'ref-1', response: [] });
        complete?.();
        return { unsubscribe: vi.fn() };
      }),
    });
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

  it('bridges match:search-requested to semiont.match.search()', async () => {
    const { getEventBus } = renderBindFlow();

    act(() => {
      getEventBus().get('match:search-requested').next({
        correlationId: 'corr-1',
        resourceId: 'resource-123',
        referenceId: 'ref-1',
        context: { sourceContext: { selected: 'test' } },
        limit: 10,
        useSemanticScoring: true,
      });
    });

    await waitFor(() => {
      expect(mockMatchSearch).toHaveBeenCalledWith(
        expect.anything(), // resourceId
        'ref-1',
        expect.anything(), // context
        expect.objectContaining({ limit: 10, useSemanticScoring: true }),
      );
    });
  });

  it('emits match:search-results on successful search', async () => {
    const { getEventBus } = renderBindFlow();
    const resultListener = vi.fn();
    getEventBus().get('match:search-results').subscribe(resultListener);

    act(() => {
      getEventBus().get('match:search-requested').next({
        correlationId: 'corr-2',
        resourceId: 'resource-123',
        referenceId: 'ref-2',
        context: {},
      });
    });

    await waitFor(() => {
      expect(resultListener).toHaveBeenCalled();
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
