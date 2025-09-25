import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import { renderHook } from '@testing-library/react';
import { useAuth, useUserPreferences, usePermissions } from '../useAuth';

// Mock next-auth/react
vi.mock('next-auth/react', () => ({
  useSession: vi.fn()
}));

// Mock validation
vi.mock('@/lib/validation', () => ({
  validateData: vi.fn(),
  JWTTokenSchema: {}
}));

// Import mocked functions
import { useSession } from 'next-auth/react';
import { validateData } from '@/lib/validation';

// Type the mocked functions
const mockUseSession = useSession as MockedFunction<typeof useSession>;
const mockValidateData = validateData as MockedFunction<typeof validateData>;

// Test data fixtures - typed as any for test simplicity
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
  minimal: {
    data: {
      user: { 
        email: 'test@example.com' 
      },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  },
  full: {
    data: {
      user: {
        email: 'john@company.com',
        name: 'John Doe',
        image: 'https://example.com/avatar.jpg'
      },
      backendToken: 'valid.jwt.token',
      backendUser: {
        id: '123',
        email: 'john@company.com',
        name: 'John Doe',
        domain: 'company.com',
        isAdmin: false,
        termsAcceptedAt: '2024-01-01'
      },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  },
  admin: {
    data: {
      user: {
        email: 'admin@company.com',
        name: 'Admin User',
        image: 'https://example.com/admin-avatar.jpg'
      },
      backendToken: 'admin.jwt.token',
      backendUser: {
        id: '456',
        email: 'admin@company.com',
        name: 'Admin User',
        domain: 'company.com',
        isAdmin: true,
        isModerator: false,
        termsAcceptedAt: '2024-01-01'
      },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  },
  noBackendToken: {
    data: {
      user: {
        email: 'user@example.com',
        name: 'No Backend User'
      },
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  },
  invalidToken: {
    data: {
      user: {
        email: 'user@example.com',
        name: 'Invalid Token User'
      },
      backendToken: 'invalid-token',
      expires: '2024-12-31'
    },
    status: 'authenticated' as const,
    update: vi.fn()
  }
};

describe('useAuth Hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useAuth', () => {
    describe('Initial State', () => {
      it('should return loading state when session is loading', () => {
        mockUseSession.mockReturnValue(mockSessions.loading);
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.isLoading).toBe(true);
        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.isFullyAuthenticated).toBe(false);
        expect(result.current.session).toBeNull();
        expect(result.current.user).toBeUndefined();
      });

      it('should return unauthenticated state when no session', () => {
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.isLoading).toBe(false);
        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.isFullyAuthenticated).toBe(false);
        expect(result.current.hasValidBackendToken).toBe(false);
        expect(result.current.session).toBeNull();
      });

      it('should return authenticated state with valid session', () => {
        mockUseSession.mockReturnValue(mockSessions.minimal);
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.isLoading).toBe(false);
        expect(result.current.isAuthenticated).toBe(true);
        expect(result.current.session).toBeDefined();
        expect(result.current.user).toEqual({ email: 'test@example.com' });
      });
    });

    describe('Session State Variations', () => {
      it('should handle session with minimal user data', () => {
        mockUseSession.mockReturnValue(mockSessions.minimal);
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.user).toEqual({ email: 'test@example.com' });
        expect(result.current.displayName).toBe('test');
        expect(result.current.userDomain).toBe('example.com');
        expect(result.current.avatarUrl).toBeUndefined();
        expect(result.current.isAdmin).toBe(false);
      });

      it('should handle session with full user data', () => {
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.user).toEqual({
          email: 'john@company.com',
          name: 'John Doe',
          image: 'https://example.com/avatar.jpg'
        });
        expect(result.current.backendUser).toEqual({
          id: '123',
          email: 'john@company.com',
          name: 'John Doe',
          domain: 'company.com',
          isAdmin: false,
          termsAcceptedAt: '2024-01-01'
        });
        expect(result.current.displayName).toBe('John Doe');
        expect(result.current.userDomain).toBe('company.com');
        expect(result.current.avatarUrl).toBe('https://example.com/avatar.jpg');
      });

      it('should handle session with backend token', () => {
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.hasValidBackendToken).toBe(true);
        expect(result.current.isFullyAuthenticated).toBe(true);
        expect(mockValidateData).toHaveBeenCalledWith(
          expect.anything(),
          'valid.jwt.token'
        );
      });

      it('should handle session without backend token', () => {
        mockUseSession.mockReturnValue(mockSessions.noBackendToken);
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.hasValidBackendToken).toBe(false);
        expect(result.current.isFullyAuthenticated).toBe(false);
        expect(result.current.backendUser).toBeUndefined();
      });
    });

    describe('Token Validation', () => {
      it('should validate backend token when present', () => {
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        const { result } = renderHook(() => useAuth());
        
        expect(mockValidateData).toHaveBeenCalledWith(
          expect.anything(),
          'valid.jwt.token'
        );
        expect(result.current.hasValidBackendToken).toBe(true);
      });

      it('should return false for invalid token format', () => {
        mockUseSession.mockReturnValue(mockSessions.invalidToken);
        mockValidateData.mockReturnValue({
          success: false,
          error: 'Invalid JWT token format' as any
        });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.hasValidBackendToken).toBe(false);
        expect(result.current.isFullyAuthenticated).toBe(false);
      });

      it('should return false when no token present', () => {
        mockUseSession.mockReturnValue(mockSessions.noBackendToken);
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.hasValidBackendToken).toBe(false);
        expect(mockValidateData).not.toHaveBeenCalled();
      });
    });

    describe('Computed Properties', () => {
      it('should extract userDomain from email correctly', () => {
        mockUseSession.mockReturnValue(mockSessions.minimal);
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.userDomain).toBe('example.com');
      });

      it('should use backend user domain when available', () => {
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.userDomain).toBe('company.com');
      });

      it('should handle missing email gracefully', () => {
        mockUseSession.mockReturnValue({
          data: {
            user: {},
            expires: '2024-12-31'
          },
          status: 'authenticated' as const,
          update: vi.fn()
        });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.userDomain).toBeUndefined();
        expect(result.current.displayName).toBe('User');
      });

      it('should compute displayName from various sources', () => {
        // Test priority: name > email > default
        
        // With name
        mockUseSession.mockReturnValue(mockSessions.full);
        const { result: result1 } = renderHook(() => useAuth());
        expect(result1.current.displayName).toBe('John Doe');
        
        // With email only
        mockUseSession.mockReturnValue(mockSessions.minimal);
        const { result: result2 } = renderHook(() => useAuth());
        expect(result2.current.displayName).toBe('test');
        
        // With nothing
        mockUseSession.mockReturnValue({
          data: {
            user: {},
            expires: '2024-12-31'
          },
          status: 'authenticated' as const,
          update: vi.fn()
        });
        const { result: result3 } = renderHook(() => useAuth());
        expect(result3.current.displayName).toBe('User');
      });

      it('should return isAdmin from backendUser', () => {
        mockUseSession.mockReturnValue(mockSessions.admin);
        mockValidateData.mockReturnValue({ success: true, data: 'admin.jwt.token' });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.isAdmin).toBe(true);
      });

      it('should calculate isFullyAuthenticated correctly', () => {
        // Not authenticated
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);
        const { result: result1 } = renderHook(() => useAuth());
        expect(result1.current.isFullyAuthenticated).toBe(false);
        
        // Authenticated but no backend token
        mockUseSession.mockReturnValue(mockSessions.noBackendToken);
        const { result: result2 } = renderHook(() => useAuth());
        expect(result2.current.isFullyAuthenticated).toBe(false);
        
        // Authenticated with valid backend token
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        const { result: result3 } = renderHook(() => useAuth());
        expect(result3.current.isFullyAuthenticated).toBe(true);
      });
    });

    describe('Edge Cases', () => {
      it('should handle null/undefined session gracefully', () => {
        mockUseSession.mockReturnValue({
          data: null,
          status: 'unauthenticated' as const,
          update: vi.fn()
        });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.user).toBeUndefined();
        expect(result.current.backendUser).toBeUndefined();
      });

      it('should handle malformed session data', () => {
        mockUseSession.mockReturnValue({
          data: {
            // Missing user property
            expires: '2024-12-31'
          } as any,
          status: 'authenticated' as const,
          update: vi.fn()
        });
        
        const { result } = renderHook(() => useAuth());
        
        expect(result.current.isAuthenticated).toBe(false);
        expect(result.current.user).toBeUndefined();
      });

      it('should memoize results properly', () => {
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        const { result, rerender } = renderHook(() => useAuth());
        
        const firstResult = result.current;
        
        // Re-render with same session
        rerender();
        
        const secondResult = result.current;
        
        // Should be the same reference (memoized)
        expect(firstResult).toBe(secondResult);
      });
    });
  });

  describe('useUserPreferences', () => {
    describe('Default Preferences', () => {
      it('should return correct default theme', () => {
        mockUseSession.mockReturnValue(mockSessions.minimal);
        
        const { result } = renderHook(() => useUserPreferences());
        
        expect(result.current.theme).toBe('system');
      });

      it('should return correct default language', () => {
        mockUseSession.mockReturnValue(mockSessions.minimal);
        
        const { result } = renderHook(() => useUserPreferences());
        
        expect(result.current.language).toBe('en');
      });

      it('should return system timezone', () => {
        mockUseSession.mockReturnValue(mockSessions.minimal);
        
        const { result } = renderHook(() => useUserPreferences());
        
        expect(result.current.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      });

      it('should return correct notification settings', () => {
        mockUseSession.mockReturnValue(mockSessions.minimal);
        
        const { result } = renderHook(() => useUserPreferences());
        
        expect(result.current.emailNotifications).toBe(true);
      });
    });

    describe('Hook Integration', () => {
      it('should return same preferences regardless of session state', () => {
        // Test with different sessions to ensure it returns static defaults
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);
        const { result: result1 } = renderHook(() => useUserPreferences());
        
        mockUseSession.mockReturnValue(mockSessions.full);
        const { result: result2 } = renderHook(() => useUserPreferences());
        
        expect(result1.current).toEqual(result2.current);
      });
    });
  });

  describe('usePermissions', () => {
    describe('Unauthenticated State', () => {
      it('should return all false permissions when not authenticated', () => {
        mockUseSession.mockReturnValue(mockSessions.unauthenticated);
        
        const { result } = renderHook(() => usePermissions());
        
        expect(result.current).toEqual({
          canRead: false,
          canWrite: false,
          canAdmin: false,
          canManageUsers: false,
        });
      });

      it('should return all false when no backend user', () => {
        mockUseSession.mockReturnValue(mockSessions.noBackendToken);
        
        const { result } = renderHook(() => usePermissions());
        
        expect(result.current).toEqual({
          canRead: false,
          canWrite: false,
          canAdmin: false,
          canManageUsers: false,
        });
      });
    });

    describe('Authenticated State', () => {
      it('should return correct permissions for authenticated user', () => {
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        const { result } = renderHook(() => usePermissions());
        
        expect(result.current).toEqual({
          canRead: true,
          canWrite: true,
          canAdmin: false,
          canManageUsers: false,
        });
      });

      it('should return correct permissions for admin user', () => {
        mockUseSession.mockReturnValue(mockSessions.admin);
        mockValidateData.mockReturnValue({ success: true, data: 'admin.jwt.token' });
        
        const { result } = renderHook(() => usePermissions());
        
        // Current implementation doesn't check isAdmin for permissions
        // but the structure is in place for future expansion
        expect(result.current).toEqual({
          canRead: true,
          canWrite: true,
          canAdmin: false,
          canManageUsers: false,
        });
      });
    });

    describe('Edge Cases', () => {
      it('should handle partial authentication states', () => {
        // Authenticated but invalid backend token
        mockUseSession.mockReturnValue(mockSessions.invalidToken);
        mockValidateData.mockReturnValue({
          success: false,
          error: 'Invalid token' as any
        });
        
        const { result } = renderHook(() => usePermissions());
        
        expect(result.current).toEqual({
          canRead: false,
          canWrite: false,
          canAdmin: false,
          canManageUsers: false,
        });
      });

      it('should memoize results properly', () => {
        mockUseSession.mockReturnValue(mockSessions.full);
        mockValidateData.mockReturnValue({ success: true, data: 'valid.jwt.token' });
        
        const { result, rerender } = renderHook(() => usePermissions());
        
        const firstResult = result.current;
        
        // Re-render
        rerender();
        
        const secondResult = result.current;
        
        // Should be the same reference (memoized)
        expect(firstResult).toBe(secondResult);
      });
    });
  });
});