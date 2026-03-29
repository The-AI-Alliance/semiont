/**
 * Integration tests for auth token flow
 *
 * Tests that token flows from session → context → API calls
 */

import { renderHook } from '@testing-library/react';
import React from 'react';
import { AuthTokenProvider, useAuthToken as useAuthTokenFromContext } from '@semiont/react-ui';
import { vi } from 'vitest';

describe('Auth Token Integration', () => {
  it('should pass token from provider through context', () => {
    const { result } = renderHook(
      () => useAuthTokenFromContext(),
      {
        wrapper: ({ children }) => (
          <AuthTokenProvider token="test-token">
            {children}
          </AuthTokenProvider>
        ),
      }
    );

    expect(result.current).toBe('test-token');
  });

  it('should handle null token', () => {
    const { result } = renderHook(
      () => useAuthTokenFromContext(),
      {
        wrapper: ({ children }) => (
          <AuthTokenProvider token={null}>
            {children}
          </AuthTokenProvider>
        ),
      }
    );

    expect(result.current).toBe(null);
  });

  it('should throw error when useAuthToken used outside provider', () => {
    // Suppress console.error for this test
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useAuthTokenFromContext());
    }).toThrow('useAuthToken must be used within an AuthTokenProvider');

    consoleError.mockRestore();
  });
});

