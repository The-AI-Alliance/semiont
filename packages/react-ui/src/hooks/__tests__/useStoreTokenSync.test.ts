/**
 * useStoreTokenSync tests
 *
 * Verifies that setTokenGetter is called on both stores when the hook mounts,
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
  let resourcesSetTokenGetter: ReturnType<typeof vi.fn>;
  let annotationsSetTokenGetter: ReturnType<typeof vi.fn>;
  let mockClient: any;

  beforeEach(() => {
    resourcesSetTokenGetter = vi.fn();
    annotationsSetTokenGetter = vi.fn();
    mockClient = {
      stores: {
        resources: { setTokenGetter: resourcesSetTokenGetter },
        annotations: { setTokenGetter: annotationsSetTokenGetter },
      },
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

  it('calls setTokenGetter on resources store on mount', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper('my-token') });
    expect(resourcesSetTokenGetter).toHaveBeenCalledOnce();
    expect(typeof resourcesSetTokenGetter.mock.calls[0][0]).toBe('function');
  });

  it('calls setTokenGetter on annotations store on mount', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper('my-token') });
    expect(annotationsSetTokenGetter).toHaveBeenCalledOnce();
    expect(typeof annotationsSetTokenGetter.mock.calls[0][0]).toBe('function');
  });

  it('getter returns an AccessToken when token is present', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper('abc-token') });
    const getter = resourcesSetTokenGetter.mock.calls[0][0] as () => unknown;
    // accessToken from @semiont/core is not mocked here — getter returns the branded value
    expect(getter()).toBeTruthy();
  });

  it('getter returns undefined when token is null', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper(null) });
    const getter = resourcesSetTokenGetter.mock.calls[0][0] as () => unknown;
    expect(getter()).toBeUndefined();
  });

  it('both stores receive the same getter function', () => {
    renderHook(() => useStoreTokenSync(), { wrapper: makeWrapper('tok') });
    const resourcesGetter = resourcesSetTokenGetter.mock.calls[0][0];
    const annotationsGetter = annotationsSetTokenGetter.mock.calls[0][0];
    // Both should be the same function reference
    expect(resourcesGetter).toBe(annotationsGetter);
  });
});
