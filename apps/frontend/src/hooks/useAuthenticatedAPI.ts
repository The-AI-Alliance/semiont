import { useCallback } from 'react';
import { env } from '@/lib/env';
import { useSession } from 'next-auth/react';
import { APIError } from '@/lib/api';

export interface FetchAPIOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}

export type FetchAPI = (url: string, options?: FetchAPIOptions) => Promise<any>;

export interface UseAuthenticatedAPIResult {
  fetchAPI: FetchAPI;
  isAuthenticated: boolean;
}

/**
 * Hook that provides an authenticated fetch function for API calls.
 *
 * The returned `fetchAPI` function:
 * - Automatically adds Authorization header with session token
 * - Throws an error if no session token is available
 * - Parses error responses and throws APIError instances
 * - Returns parsed JSON response on success
 *
 * @example
 * ```typescript
 * const { fetchAPI, isAuthenticated } = useAuthenticatedAPI();
 *
 * const { data } = useQuery({
 *   queryKey: ['/api/documents'],
 *   queryFn: () => fetchAPI('/api/documents'),
 *   enabled: isAuthenticated,
 * });
 * ```
 */
export function useAuthenticatedAPI(): UseAuthenticatedAPIResult {
  const { data: session } = useSession();

  const fetchAPI: FetchAPI = useCallback(
    async (url: string, options?: FetchAPIOptions) => {
      // Fail loudly if no token is available - no defaults!
      if (!session?.backendToken) {
        throw new Error('Authentication required. No session token available.');
      }

      // Build full URL
      const baseUrl = env.NEXT_PUBLIC_API_URL;
      const fullUrl = `${baseUrl}${url}`;

      // Merge headers with auth token
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.backendToken}`,
        ...options?.headers,
      };

      // Make authenticated request
      const response = await fetch(fullUrl, {
        ...options,
        headers,
      });

      // Handle errors
      if (!response.ok) {
        const errorText = await response.text();
        let errorData: any;

        try {
          errorData = JSON.parse(errorText);
        } catch {
          // If response is not JSON, wrap in error object
          errorData = { error: errorText };
        }

        throw new APIError(response.status, errorData);
      }

      // Handle 204 No Content responses
      if (response.status === 204) {
        return undefined;
      }

      // Parse and return JSON response
      return response.json();
    },
    [session?.backendToken]
  );

  return {
    fetchAPI,
    isAuthenticated: !!session?.backendToken,
  };
}
