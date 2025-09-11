import { useQuery, useMutation, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import { api, apiService } from '@/lib/api-client';
import { useAuth } from './useAuth';

/**
 * Hook for backend status with automatic polling
 */
export function useBackendStatus(options?: {
  pollingInterval?: number;
  enabled?: boolean;
}) {
  const { session, isFullyAuthenticated } = useAuth();
  
  return useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      // If token is provided, use an authenticated request
      if (session?.backendToken) {
        const instance = (await import('@/lib/api-client')).LazyTypedAPIClient.getInstance();
        const originalAuth = instance.getAuthToken();
        try {
          instance.setAuthToken(session.backendToken);
          return await apiService.status();
        } finally {
          // Restore original auth state
          if (originalAuth) {
            instance.setAuthHeader(originalAuth);
          } else {
            instance.clearAuthToken();
          }
        }
      }
      // Otherwise make unauthenticated request
      return apiService.status();
    },
    enabled: options?.enabled !== false && isFullyAuthenticated,
    ...(options?.pollingInterval !== undefined ? { refetchInterval: options.pollingInterval } : {}),
  });
}

/**
 * Hook for health check with connection monitoring
 */
export function useHealthCheck() {
  return api.health.useQuery();
}

/**
 * Hook for authenticated API calls
 */
export function useAuthenticatedAPI() {
  const { isFullyAuthenticated, session } = useAuth();

  // User profile query
  const useUserProfile = () => {
    return api.auth.me.useQuery();
  };

  // Logout mutation
  const useLogout = () => {
    return api.auth.logout.useMutation();
  };

  return {
    useUserProfile,
    useLogout,
    isReady: isFullyAuthenticated,
  };
}

/**
 * Generic API hook with error handling and loading states
 */
export function useAPICall<T>(
  queryKey: string[],
  queryFn: () => Promise<T>,
  options?: UseQueryOptions<T>
) {
  return useQuery({
    queryKey,
    queryFn,
    ...options,
    meta: {
      ...options?.meta,
      timestamp: Date.now(),
    },
  });
}

/**
 * Hook for handling API mutations with optimistic updates
 */
export function useAPIMutation<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options?: UseMutationOptions<TData, Error, TVariables>
) {
  return useMutation({
    mutationFn,
    ...options,
    onError: (error, variables, context) => {
      // Log error for debugging
      console.error('API Mutation Error:', error);
      
      // Call custom error handler if provided
      options?.onError?.(error, variables, context);
    },
  });
}