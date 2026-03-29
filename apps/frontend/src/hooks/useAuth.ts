'use client';

import { useMemo } from 'react';
import { useAuthContext } from '@/contexts/AuthContext';

/**
 * Enhanced authentication hook
 */
export function useAuth() {
  const { session, isLoading } = useAuthContext();

  return useMemo(() => {
    const isAuthenticated = !!session;
    const user = session?.user ?? null;

    return {
      session,
      user,
      backendUser: user,
      token: session?.token ?? null,

      isLoading,
      isAuthenticated,
      hasValidBackendToken: !!session?.token,
      isFullyAuthenticated: isAuthenticated,

      userDomain: user?.domain || user?.email?.split('@')[1],
      displayName: user?.name ?? user?.email?.split('@')[0] ?? 'User',
      avatarUrl: user?.image ?? null,
      isAdmin: user?.isAdmin ?? false,
      isModerator: false,
    };
  }, [session, isLoading]);
}

/**
 * Hook for getting user preferences and settings
 */
export function useUserPreferences() {
  return useMemo(() => ({
    theme: 'system' as 'light' | 'dark' | 'system',
    language: 'en',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    emailNotifications: true,
  }), []);
}

/**
 * Hook for checking user permissions
 */
export function usePermissions() {
  const { isFullyAuthenticated, backendUser } = useAuth();

  return useMemo(() => {
    if (!isFullyAuthenticated || !backendUser) {
      return { canRead: false, canWrite: false, canAdmin: false, canManageUsers: false };
    }
    return { canRead: true, canWrite: true, canAdmin: false, canManageUsers: false };
  }, [backendUser, isFullyAuthenticated]);
}
