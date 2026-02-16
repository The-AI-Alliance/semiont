/**
 * Integration tests for auth token flow
 *
 * Tests that token flows from session → context → API calls
 */

import { renderHook } from '@testing-library/react';
import { SessionProvider, useSession } from 'next-auth/react';
import { AuthTokenProvider, useAuthToken as useAuthTokenFromContext } from '@semiont/react-ui';
import { vi } from 'vitest';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('Auth Token Integration', () => {
  it('should pass token from session through context', () => {
    const mockSession = {
      data: { backendToken: 'test-token' } as any,
      status: 'authenticated' as const,
      update: vi.fn(),
    };

    vi.mocked(useSession).mockReturnValue(mockSession);

    const { result } = renderHook(
      () => useAuthTokenFromContext(),
      {
        wrapper: ({ children }) => (
          <SessionProvider>
            <AuthTokenProvider token={mockSession.data.backendToken}>
              {children}
            </AuthTokenProvider>
          </SessionProvider>
        ),
      }
    );

    // Token should be available from context
    expect(result.current).toBe('test-token');
  });

  it('should handle null session', () => {
    const mockSession = {
      data: null,
      status: 'unauthenticated' as const,
      update: vi.fn(),
    };

    vi.mocked(useSession).mockReturnValue(mockSession);

    const { result } = renderHook(
      () => useAuthTokenFromContext(),
      {
        wrapper: ({ children }) => (
          <SessionProvider>
            <AuthTokenProvider token={null}>
              {children}
            </AuthTokenProvider>
          </SessionProvider>
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

