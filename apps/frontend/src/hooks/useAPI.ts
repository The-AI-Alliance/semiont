import { useQuery, useMutation, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useAuth } from './useAuth';

/**
 * Hook for greeting API with enhanced error handling
 */
export function useGreeting(name?: string) {
  return api.hello.greeting.useQuery(name ? { name } : {});
}

/**
 * Hook for backend status with automatic polling
 */
export function useBackendStatus(options?: {
  pollingInterval?: number;
  enabled?: boolean;
}) {
  const { session, isFullyAuthenticated } = useAuth();
  
  // Debug logging
  if (typeof window !== 'undefined') {
    console.log('useBackendStatus:', {
      isFullyAuthenticated,
      hasBackendToken: !!session?.backendToken,
      tokenPreview: session?.backendToken ? `${session.backendToken.substring(0, 20)}...` : 'none'
    });
  }
  
  return api.hello.getStatus.useQuery({
    ...(session?.backendToken ? { token: session.backendToken } : {}),
    enabled: options?.enabled !== false && isFullyAuthenticated,
    ...(options?.pollingInterval !== undefined ? { pollingInterval: options.pollingInterval } : {}),
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