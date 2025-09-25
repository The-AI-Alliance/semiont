import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import { renderHook, act } from '@testing-library/react';
import { useSecureAPI, useRequireAuth } from '../useSecureAPI';

// Mock next-auth/react
vi.mock('next-auth/react', () => ({
  useSession: vi.fn()
}));

// Mock api-client
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    setAuthToken: vi.fn(),
    clearAuthToken: vi.fn()
  }
}));

// Mock validation
vi.mock('@/lib/validation', () => ({
  validateData: vi.fn(),
  JWTTokenSchema: {}
}));

// Import mocked functions
import { useSession } from 'next-auth/react';
import { apiClient } from '@/lib/api-client';
import { validateData } from '@/lib/validation';

// Type the mocked functions
const mockUseSession = useSession as MockedFunction<typeof useSession>;
const mockApiClient = apiClient as any;
const mockValidateData = validateData as MockedFunction<typeof validateData>;

// Test data fixtures
const mockSessions: Record<string, any> = {
  loading: {
    data: null,
    status: 'loading' as const,
    update: vi.fn()
  },
  unauthenticated: {
    data: null,
    status: 'unauthenticated' as const,
    update: vi.fn()
  },
  withValidToken: {
    data: {
      backendToken: 'valid.jwt.token',
      user: { email: 'test@example.com' },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  },
  withInvalidToken: {
    data: {
      backendToken: 'invalid-token',
      user: { email: 'test@example.com' },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  },
  withoutToken: {
    data: {
      user: { email: 'test@example.com' },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  },
  withDifferentToken: {
    data: {
      backendToken: 'different.jwt.token',
      user: { email: 'test@example.com' },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  }
};

describe('useSecureAPI Hooks', () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('useSecureAPI', () => {
    describe('Token Management', () => {
      it('should set token when valid backend token is present', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ 
          success: true, 
          data: 'valid.jwt.token' 
        });

        const { result } = renderHook(() => useSecureAPI());

        expect(mockValidateData).toHaveBeenCalledWith(
          expect.anything(),
          'valid.jwt.token'
        );
        expect(mockApiClient.setAuthToken).toHaveBeenCalledWith('valid.jwt.token');
        expect(consoleLogSpy).toHaveBeenCalledWith('Auth token updated in API client');
      });

      it('should not clear token initially when no backend token is present', () => {
        mockUseSession.mockReturnValue(mockSessions.withoutToken);

        const { result } = renderHook(() => useSecureAPI());

        // Since lastTokenRef starts as null, clearAuthToken shouldn't be called initially
        expect(mockApiClient.clearAuthToken).not.toHaveBeenCalled();
        expect(consoleLogSpy).not.toHaveBeenCalledWith('Auth token cleared from API client');
        expect(result.current.hasValidToken).toBe(false);
        expect(result.current.isAuthenticated).toBe(false);
      });

      it('should not clear token initially when session is null', () => {
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);

        const { result } = renderHook(() => useSecureAPI());

        // Since lastTokenRef starts as null, clearAuthToken shouldn't be called initially
        expect(mockApiClient.clearAuthToken).not.toHaveBeenCalled();
        expect(consoleLogSpy).not.toHaveBeenCalledWith('Auth token cleared from API client');
        expect(result.current.hasValidToken).toBe(false);
        expect(result.current.isAuthenticated).toBe(false);
      });

      it('should update token when token changes', () => {
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        // Initial render with first token
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        const { rerender } = renderHook(() => useSecureAPI());
        
        expect(mockApiClient.setAuthToken).toHaveBeenCalledWith('valid.jwt.token');
        expect(mockApiClient.setAuthToken).toHaveBeenCalledTimes(1);

        // Update with different token
        mockValidateData.mockReturnValue({ success: true, data: 'different.jwt.token' });
        mockUseSession.mockReturnValue(mockSessions.withDifferentToken);
        rerender();

        expect(mockApiClient.setAuthToken).toHaveBeenCalledWith('different.jwt.token');
        expect(mockApiClient.setAuthToken).toHaveBeenCalledTimes(2);
      });

      it('should not update if token has not changed', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ 
          success: true, 
          data: 'valid.jwt.token' 
        });

        const { rerender } = renderHook(() => useSecureAPI());
        
        expect(mockApiClient.setAuthToken).toHaveBeenCalledTimes(1);

        // Re-render with same token
        rerender();

        // Should not call setAuthToken again
        expect(mockApiClient.setAuthToken).toHaveBeenCalledTimes(1);
      });

      it('should clear token when validation fails', () => {
        mockUseSession.mockReturnValue(mockSessions.withInvalidToken);
        mockValidateData.mockReturnValue({ 
          success: false, 
          error: 'Invalid JWT token format' 
        });

        renderHook(() => useSecureAPI());

        expect(mockApiClient.clearAuthToken).toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Invalid session token detected:',
          'Invalid JWT token format'
        );
      });
    });

    describe('Validation Tests', () => {
      it('should validate token before setting', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });

        renderHook(() => useSecureAPI());

        expect(mockValidateData).toHaveBeenCalledWith(
          expect.anything(),
          'valid.jwt.token'
        );
      });

      it('should handle validation success', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });

        const { result, rerender } = renderHook(() => useSecureAPI());

        // The effect runs and should set the lastTokenRef
        expect(mockApiClient.setAuthToken).toHaveBeenCalledWith('valid.jwt.token');
        
        // Force a re-render to get updated return values based on the ref
        rerender();
        
        expect(result.current.hasValidToken).toBe(true);
        expect(result.current.isAuthenticated).toBe(true);
      });

      it('should handle validation failure', () => {
        mockUseSession.mockReturnValue(mockSessions.withInvalidToken);
        mockValidateData.mockReturnValue({ 
          success: false, 
          error: 'Invalid token' 
        });

        const { result } = renderHook(() => useSecureAPI());

        expect(result.current.hasValidToken).toBe(false);
        expect(result.current.isAuthenticated).toBe(false);
        expect(mockApiClient.clearAuthToken).toHaveBeenCalled();
      });

      it('should log appropriate error messages on validation failure', () => {
        mockUseSession.mockReturnValue(mockSessions.withInvalidToken);
        mockValidateData.mockReturnValue({
          success: false,
          error: 'Invalid JWT token format'
        });

        renderHook(() => useSecureAPI());

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Invalid session token detected:',
          'Invalid JWT token format'
        );
      });
    });

    describe('State Management', () => {
      it('should return correct isAuthenticated status', () => {
        // Not authenticated - no session
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);
        const { result: result1 } = renderHook(() => useSecureAPI());
        expect(result1.current.isAuthenticated).toBe(false);

        // Not authenticated - no token
        mockUseSession.mockReturnValue(mockSessions.withoutToken);
        const { result: result2 } = renderHook(() => useSecureAPI());
        expect(result2.current.isAuthenticated).toBe(false);

        // Authenticated - with valid token
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        const { result: result3, rerender: rerender3 } = renderHook(() => useSecureAPI());
        rerender3(); // Force re-render to get updated ref values
        expect(result3.current.isAuthenticated).toBe(true);
      });

      it('should return correct hasValidToken status', () => {
        // No valid token - no session
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);
        const { result: result1 } = renderHook(() => useSecureAPI());
        expect(result1.current.hasValidToken).toBe(false);

        // No valid token - invalid token
        mockUseSession.mockReturnValue(mockSessions.withInvalidToken);
        mockValidateData.mockReturnValue({ success: false, error: 'Invalid' });
        const { result: result2 } = renderHook(() => useSecureAPI());
        expect(result2.current.hasValidToken).toBe(false);

        // Has valid token
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        const { result: result3, rerender: rerender3 } = renderHook(() => useSecureAPI());
        rerender3(); // Force re-render to get updated ref values
        expect(result3.current.hasValidToken).toBe(true);
      });

      it('should update state based on token validation changes', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        
        // Initially valid
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        const { result, rerender } = renderHook(() => useSecureAPI());
        rerender(); // Force re-render to get initial ref values
        expect(result.current.hasValidToken).toBe(true);

        // Change to invalid - the key is that the session still has backendToken but validation fails
        mockValidateData.mockReturnValue({ success: false, error: 'Invalid' });
        mockUseSession.mockReturnValue(mockSessions.withInvalidToken);
        rerender(); // This should trigger the effect again
        rerender(); // And another rerender to get the updated state
        expect(result.current.hasValidToken).toBe(false);
      });
    });

    describe('Effect Dependencies', () => {
      it('should re-run effect when session.backendToken changes', () => {
        // Initial render
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        const { rerender } = renderHook(() => useSecureAPI());

        expect(mockApiClient.setAuthToken).toHaveBeenCalledTimes(1);

        // Change token
        mockUseSession.mockReturnValue(mockSessions.withDifferentToken);
        mockValidateData.mockReturnValue({ success: true, data: 'different.jwt.token' });
        rerender();

        expect(mockApiClient.setAuthToken).toHaveBeenCalledTimes(2);
        expect(mockApiClient.setAuthToken).toHaveBeenLastCalledWith('different.jwt.token');
      });

      it('should handle transition from token to no token', () => {
        // Start with token
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        const { rerender } = renderHook(() => useSecureAPI());

        expect(mockApiClient.setAuthToken).toHaveBeenCalledWith('valid.jwt.token');

        // Remove token
        mockUseSession.mockReturnValue(mockSessions.withoutToken);
        rerender();

        expect(mockApiClient.clearAuthToken).toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith('Auth token cleared from API client');
      });
    });

    describe('Edge Cases', () => {
      it('should handle session with undefined backendToken gracefully', () => {
        mockUseSession.mockReturnValue({
          data: {
            user: { email: 'test@example.com' },
            expires: '2024-12-31'
          } as any,
          status: 'authenticated' as const,
          update: vi.fn()
        });

        const { result } = renderHook(() => useSecureAPI());

        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.hasValidToken).toBe(false);
        // Should NOT call clearAuthToken since no previous token existed
        expect(mockApiClient.clearAuthToken).not.toHaveBeenCalled();
      });

      it('should not log clear message if no previous token existed', () => {
        mockUseSession.mockReturnValue(mockSessions.withoutToken);

        renderHook(() => useSecureAPI());

        // Should NOT call clearAuthToken since no previous token existed (ref starts as null)
        expect(mockApiClient.clearAuthToken).not.toHaveBeenCalled();
        expect(consoleLogSpy).not.toHaveBeenCalledWith('Auth token cleared from API client');
      });
    });
  });

  describe('useRequireAuth', () => {
    describe('Authentication States', () => {
      it('should return loading state during session load', () => {
        mockUseSession.mockReturnValue(mockSessions.loading);

        const { result } = renderHook(() => useRequireAuth());

        expect(result.current.isLoading).toBe(true);
        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.session).toBeNull();
      });

      it('should return unauthenticated when no session', () => {
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);

        const { result } = renderHook(() => useRequireAuth());

        expect(result.current.isLoading).toBe(false);
        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.session).toBeNull();
      });

      it('should return authenticated with valid session and token', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });

        const { result, rerender } = renderHook(() => useRequireAuth());
        rerender(); // Force re-render to get updated ref values from useSecureAPI

        expect(result.current.isLoading).toBe(false);
        expect(result.current.isAuthenticated).toBe(true);
        expect(result.current.session).toBeDefined();
      });

      it('should return unauthenticated with session but invalid token', () => {
        mockUseSession.mockReturnValue(mockSessions.withInvalidToken);
        mockValidateData.mockReturnValue({ success: false, error: 'Invalid' });

        const { result } = renderHook(() => useRequireAuth());

        expect(result.current.isLoading).toBe(false);
        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.session).toBeDefined();
      });

      it('should call onUnauthenticated callback appropriately', () => {
        const onUnauthenticatedSpy = vi.fn();
        
        // Mock useSession to accept options and call onUnauthenticated
        mockUseSession.mockImplementation((options: any) => {
          if (options?.required && options?.onUnauthenticated) {
            options.onUnauthenticated();
          }
          return mockSessions.unauthenticated;
        });

        renderHook(() => useRequireAuth());

        expect(consoleLogSpy).toHaveBeenCalledWith('User not authenticated, redirecting to sign-in');
      });
    });

    describe('Integration Tests', () => {
      it('should use useSecureAPI internally', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });

        const { result, rerender } = renderHook(() => useRequireAuth());
        rerender(); // Force re-render to get updated ref values from useSecureAPI

        // Should call both useSession and useSecureAPI
        expect(result.current.isAuthenticated).toBe(true);
        expect(mockApiClient.setAuthToken).toHaveBeenCalledWith('valid.jwt.token');
      });

      it('should combine session status with token validation', () => {
        // Session exists but token is invalid
        mockUseSession.mockReturnValue(mockSessions.withInvalidToken);
        mockValidateData.mockReturnValue({ success: false, error: 'Invalid' });

        const { result } = renderHook(() => useRequireAuth());

        expect(result.current.session).toBeDefined();
        expect(result.current.isAuthenticated).toBe(false); // False because token is invalid
      });

      it('should return consistent state across re-renders', () => {
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });

        const { result, rerender } = renderHook(() => useRequireAuth());

        // First rerender to get initial state with ref updates
        rerender();
        
        const firstResult = {
          session: result.current.session,
          isLoading: result.current.isLoading,
          isAuthenticated: result.current.isAuthenticated
        };

        rerender();

        const secondResult = {
          session: result.current.session,
          isLoading: result.current.isLoading,
          isAuthenticated: result.current.isAuthenticated
        };

        expect(firstResult).toEqual(secondResult);
      });
    });

    describe('Edge Cases', () => {
      it('should handle session without user data', () => {
        mockUseSession.mockReturnValue({
          data: {
            expires: '2024-12-31'
            // No user or backendToken
          },
          status: 'authenticated' as const,
          update: vi.fn()
        });

        const { result } = renderHook(() => useRequireAuth());

        expect(result.current.session).toBeDefined();
        expect(result.current.isAuthenticated).toBe(false);
      });

      it('should handle rapid session state changes', () => {
        // Start loading
        mockUseSession.mockReturnValue(mockSessions.loading);
        const { result, rerender } = renderHook(() => useRequireAuth());
        expect(result.current.isLoading).toBe(true);

        // Change to authenticated
        mockUseSession.mockReturnValue(mockSessions.withValidToken);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        rerender();
        rerender(); // Double rerender to ensure ref updates are reflected
        expect(result.current.isLoading).toBe(false);
        expect(result.current.isAuthenticated).toBe(true);

        // Change to unauthenticated
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);
        rerender();
        expect(result.current.isLoading).toBe(false);
        expect(result.current.isAuthenticated).toBe(false);
      });
    });
  });
});