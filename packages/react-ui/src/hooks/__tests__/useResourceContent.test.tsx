import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useResourceContent } from '../useResourceContent';

const mockShowError = vi.fn();
const mockUseQuery = vi.fn();

vi.mock('../../components/Toast', () => ({
  useToast: () => ({ showError: mockShowError }),
}));

vi.mock('@semiont/api-client', () => ({
  getPrimaryMediaType: vi.fn(() => 'text/plain'),
}));

vi.mock('../../lib/api-hooks', () => ({
  useResources: vi.fn(() => ({
    representation: {
      useQuery: mockUseQuery,
    },
  })),
}));

// Minimal wrapper — hooks under test don't need full providers
function Wrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

describe('useResourceContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: null, isLoading: false, error: null });
  });

  it('returns empty content and not loading when no data', () => {
    mockUseQuery.mockReturnValue({ data: null, isLoading: false, error: null });

    const { result } = renderHook(
      () => useResourceContent('res-1' as any, { representations: [{ mediaType: 'text/plain' }] } as any),
      { wrapper: Wrapper }
    );

    expect(result.current.content).toBe('');
    expect(result.current.loading).toBe(false);
  });

  it('returns content when data is available', () => {
    mockUseQuery.mockReturnValue({ data: 'Hello World', isLoading: false, error: null });

    const { result } = renderHook(
      () => useResourceContent('res-2' as any, { representations: [{ mediaType: 'text/plain' }] } as any),
      { wrapper: Wrapper }
    );

    expect(result.current.content).toBe('Hello World');
    expect(result.current.loading).toBe(false);
  });

  it('returns loading true when query is loading', () => {
    mockUseQuery.mockReturnValue({ data: null, isLoading: true, error: null });

    const { result } = renderHook(
      () => useResourceContent('res-3' as any, { representations: [{ mediaType: 'text/plain' }] } as any),
      { wrapper: Wrapper }
    );

    expect(result.current.loading).toBe(true);
  });

  it('calls showError when error occurs', () => {
    mockUseQuery.mockReturnValue({ data: null, isLoading: false, error: new Error('Network error') });

    renderHook(
      () => useResourceContent('res-4' as any, { representations: [{ mediaType: 'text/plain' }] } as any),
      { wrapper: Wrapper }
    );

    expect(mockShowError).toHaveBeenCalledWith('Failed to load resource representation');
  });
});
