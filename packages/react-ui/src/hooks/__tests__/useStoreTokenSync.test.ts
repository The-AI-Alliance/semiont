/**
 * useStoreTokenSync tests
 *
 * Verifies that setTokenGetter is called on the client when the hook mounts,
 * and that the getter returns the current token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useStoreTokenSync } from '../useStoreTokenSync';
import { EventBusProvider } from '../../contexts/EventBusContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { SemiontApiClient } from '@semiont/api-client';

// Mock the API client
vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(function () {}),
  baseUrl: vi.fn(function (url: string) { return url; }),
}));

describe('useStoreTokenSync', () => {
  let mockSetTokenGetter: ReturnType<typeof vi.fn>;
  let mockClient: any;

  beforeEach(() => {
    mockSetTokenGetter = vi.fn();
    mockClient = {
      setTokenGetter: mockSetTokenGetter,
    };
    vi.mocked(SemiontApiClient).mockImplementation(function () { return mockClient; });
    vi.clearAllMocks();
  });

  function makeWrapper(token: string | null) {
    return ({ children }: { children: ReactNode }) =>
      React.createElement(
        EventBusProvider,
        null,
        React.createElement(
          AuthTokenProvider,
          { token },
          React.createElement(ApiClientProvider, { baseUrl: 'http://localhost:4000' }, children)
        )
      );
  }

  it('calls setTokenGetter on the client on mount', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper('my-token') });
    expect(mockSetTokenGetter).toHaveBeenCalledOnce();
    expect(typeof mockSetTokenGetter.mock.calls[0][0]).toBe('function');
  });

  it('getter returns an AccessToken when token is present', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper('abc-token') });
    const getter = mockSetTokenGetter.mock.calls[0][0] as () => unknown;
    expect(getter()).toBeTruthy();
  });

  it('getter returns undefined when token is null', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper(null) });
    const getter = mockSetTokenGetter.mock.calls[0][0] as () => unknown;
    expect(getter()).toBeUndefined();
  });
});
