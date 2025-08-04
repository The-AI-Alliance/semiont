import { useSession } from 'next-auth/react';
import { useEffect, useRef } from 'react';
import { apiClient } from '@/lib/api-client';
import { JWTTokenSchema, validateData } from '@/lib/validation';

/**
 * Hook that provides a secure API client with automatic token management
 * and validation. It automatically adds the authentication token from the
 * session and validates tokens before use.
 */
export function useSecureAPI() {
  const { data: session } = useSession();
  const lastTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (session?.backendToken) {
      // Validate token before using it
      const validation = validateData(JWTTokenSchema, session.backendToken);
      
      if (validation.success) {
        // Only update if token changed
        if (lastTokenRef.current !== validation.data) {
          apiClient.setAuthToken(validation.data);
          lastTokenRef.current = validation.data;
          console.log('Auth token updated in API client');
        }
      } else {
        console.error('Invalid session token detected:', validation.error);
        // Clear invalid token
        apiClient.clearAuthToken();
        lastTokenRef.current = null;
      }
    } else {
      // No token, clear auth
      if (lastTokenRef.current !== null) {
        apiClient.clearAuthToken();
        lastTokenRef.current = null;
        console.log('Auth token cleared from API client');
      }
    }
  }, [session?.backendToken]);

  // Return token status for components that need it
  return {
    isAuthenticated: !!session?.backendToken && !!lastTokenRef.current,
    hasValidToken: !!lastTokenRef.current,
  };
}

/**
 * Hook for components that require authentication.
 * Redirects to sign-in page if not authenticated.
 */
export function useRequireAuth() {
  const { data: session, status } = useSession({
    required: true,
    onUnauthenticated() {
      // This will redirect to the sign-in page
      console.log('User not authenticated, redirecting to sign-in');
    },
  });

  const { hasValidToken } = useSecureAPI();

  return {
    session,
    isLoading: status === 'loading',
    isAuthenticated: !!session && hasValidToken,
  };
}