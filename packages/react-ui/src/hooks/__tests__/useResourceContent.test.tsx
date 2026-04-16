import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useResourceContent } from '../useResourceContent';

const mockShowError = vi.fn();
const mockGetResourceRepresentation = vi.fn();

vi.mock('../../components/Toast', () => ({
  useToast: () => ({ showError: mockShowError }),
}));

vi.mock('@semiont/api-client', () => ({
  getPrimaryMediaType: vi.fn(() => 'text/plain'),
  decodeWithCharset: vi.fn((data: string) => data),
}));

vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual<typeof import('../../contexts/ApiClientContext')>('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      getResourceRepresentation: mockGetResourceRepresentation,
    }),
  };
});

vi.mock('../../contexts/AuthTokenContext', async () => {
  const actual = await vi.importActual<typeof import('../../contexts/AuthTokenContext')>('../../contexts/AuthTokenContext');
  return {
    ...actual,
    useAuthToken: () => 'test-token',
  };
});

// Minimal wrapper -- hooks under test don't need full providers
function Wrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

describe('useResourceContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetResourceRepresentation.mockResolvedValue({ data: '', contentType: 'text/plain' });
  });

  it('returns empty content and not loading when fetch resolves with empty data', async () => {
    mockGetResourceRepresentation.mockResolvedValue({ data: '', contentType: 'text/plain' });

    const { result } = renderHook(
      () => useResourceContent('res-1' as any, { representations: [{ mediaType: 'text/plain' }] } as any),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.content).toBe('');
  });

  it('returns content when data is available', async () => {
    mockGetResourceRepresentation.mockResolvedValue({ data: 'Hello World', contentType: 'text/plain' });

    const { result } = renderHook(
      () => useResourceContent('res-2' as any, { representations: [{ mediaType: 'text/plain' }] } as any),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.content).toBe('Hello World');
    });

    expect(result.current.loading).toBe(false);
  });

  it('transitions through loading states', async () => {
    const loadingStates: boolean[] = [];
    mockGetResourceRepresentation.mockResolvedValue({ data: 'done', contentType: 'text/plain' });

    const { result } = renderHook(
      () => {
        const r = useResourceContent('res-3' as any, { representations: [{ mediaType: 'text/plain' }] } as any);
        loadingStates.push(r.loading);
        return r;
      },
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.content).toBe('done');
    });

    expect(loadingStates).toContain(true);
    expect(result.current.loading).toBe(false);
  });

  it('calls showError when error occurs', async () => {
    mockGetResourceRepresentation.mockRejectedValue(new Error('Network error'));

    renderHook(
      () => useResourceContent('res-4' as any, { representations: [{ mediaType: 'text/plain' }] } as any),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith('Failed to load resource representation');
    });
  });
});
