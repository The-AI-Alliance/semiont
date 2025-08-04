import { useSession } from 'next-auth/react';
import { useMemo } from 'react';
import { validateData, JWTTokenSchema } from '@/lib/validation';

/**
 * Enhanced authentication hook with validation and user information
 */
export function useAuth() {
  const { data: session, status } = useSession();

  const authInfo = useMemo(() => {
    const isLoading = status === 'loading';
    const isAuthenticated = !!session?.user;
    
    // Validate backend token if present
    const hasValidBackendToken = session?.backendToken ? 
      validateData(JWTTokenSchema, session.backendToken).success : false;

    return {
      // Session data
      session,
      user: session?.user,
      backendUser: session?.backendUser,
      
      // Status flags
      isLoading,
      isAuthenticated,
      hasValidBackendToken,
      
      // Computed properties
      userDomain: session?.backendUser?.domain || session?.user?.email?.split('@')[1],
      displayName: session?.user?.name || session?.user?.email?.split('@')[0] || 'User',
      avatarUrl: session?.user?.image,
      isAdmin: session?.backendUser?.isAdmin || false,
      
      // Combined auth status
      isFullyAuthenticated: isAuthenticated && hasValidBackendToken,
    };
  }, [session, status]);

  return authInfo;
}

/**
 * Hook for getting user preferences and settings
 */
export function useUserPreferences() {
  const { session } = useAuth();

  return useMemo(() => {
    // In the future, this could fetch user preferences from backend
    // For now, return defaults
    return {
      theme: 'system' as 'light' | 'dark' | 'system',
      language: 'en',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      emailNotifications: true,
    };
  }, [session]);
}

/**
 * Hook for checking user permissions (future expansion)
 */
export function usePermissions() {
  const { backendUser, isFullyAuthenticated } = useAuth();

  return useMemo(() => {
    if (!isFullyAuthenticated || !backendUser) {
      return {
        canRead: false,
        canWrite: false,
        canAdmin: false,
        canManageUsers: false,
      };
    }

    // Basic permissions - in the future this would come from backend
    return {
      canRead: true,
      canWrite: true,
      canAdmin: false, // Determine based on user role
      canManageUsers: false,
    };
  }, [backendUser, isFullyAuthenticated]);
}