import { useQuery, useMutation, type UseQueryOptions, type UseMutationOptions, type QueryKey } from '@tanstack/react-query';
import { useAuthenticatedAPI, type FetchAPI } from '@/hooks/useAuthenticatedAPI';

/**
 * Authenticated query wrapper that automatically:
 * - Uses the authenticated fetch function from useAuthenticatedAPI
 * - Waits for authentication before executing (enabled: isAuthenticated)
 * - Allows enabled override via options
 *
 * @example
 * ```typescript
 * const { data, isLoading } = useAuthenticatedQuery(
 *   ['/api/documents'],
 *   '/api/documents'
 * );
 * ```
 */
export function useAuthenticatedQuery<TData = any>(
  queryKey: QueryKey,
  url: string,
  options?: Omit<UseQueryOptions<TData, Error>, 'queryKey' | 'queryFn'>
) {
  const { fetchAPI, isAuthenticated } = useAuthenticatedAPI();

  return useQuery<TData, Error>({
    queryKey,
    queryFn: () => fetchAPI(url),
    // Only run query if authenticated, but allow override
    enabled: options?.enabled !== undefined ? options.enabled : isAuthenticated,
    ...options,
  });
}

/**
 * Authenticated mutation wrapper that automatically:
 * - Provides the authenticated fetch function to the mutation
 * - No need to manually handle auth in mutation functions
 *
 * @example
 * ```typescript
 * const createDocument = useAuthenticatedMutation(
 *   (variables: { name: string }, fetchAPI) =>
 *     fetchAPI('/api/documents', {
 *       method: 'POST',
 *       body: JSON.stringify(variables),
 *     })
 * );
 *
 * createDocument.mutate({ name: 'New Document' });
 * ```
 */
export function useAuthenticatedMutation<TData = any, TVariables = void>(
  mutationFn: (variables: TVariables, fetchAPI: FetchAPI) => Promise<TData>,
  options?: Omit<UseMutationOptions<TData, Error, TVariables>, 'mutationFn'>
) {
  const { fetchAPI } = useAuthenticatedAPI();

  return useMutation<TData, Error, TVariables>({
    mutationFn: (variables: TVariables) => mutationFn(variables, fetchAPI),
    ...options,
  });
}

/**
 * Authenticated query with dynamic URL parameters.
 * Useful for queries that need path parameters.
 *
 * @example
 * ```typescript
 * const { data } = useAuthenticatedQueryWithParams(
 *   ['/api/documents', documentId],
 *   (params) => `/api/documents/${params[1]}`
 * );
 * ```
 */
export function useAuthenticatedQueryWithParams<TData = any>(
  queryKey: QueryKey,
  urlBuilder: (params: QueryKey) => string,
  options?: Omit<UseQueryOptions<TData, Error>, 'queryKey' | 'queryFn'>
) {
  const { fetchAPI, isAuthenticated } = useAuthenticatedAPI();

  return useQuery<TData, Error>({
    queryKey,
    queryFn: () => {
      const url = urlBuilder(queryKey);
      return fetchAPI(url);
    },
    enabled: options?.enabled !== undefined ? options.enabled : isAuthenticated,
    ...options,
  });
}
