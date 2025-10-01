import { useQuery, useMutation, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useAuth } from './useAuth';
import { useAuthenticatedAPI as useAuthAPI } from './useAuthenticatedAPI';

/**
 * Hook for backend status with automatic polling
 */
export function useBackendStatus(options?: {
  pollingInterval?: number;
  enabled?: boolean;
}) {
  const { isFullyAuthenticated } = useAuth();
  const { fetchAPI } = useAuthAPI();

  return useQuery({
    queryKey: ['/api/status'],
    queryFn: () => fetchAPI('/api/status'),
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