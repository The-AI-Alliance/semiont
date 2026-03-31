import type { ResourceId } from '@semiont/core';
import { useResources } from '../lib/api-hooks';

export interface UseMediaTokenResult {
  token: string | undefined;
  loading: boolean;
}

/**
 * Hook to fetch a short-lived media token for a binary resource.
 *
 * The token is scoped to a single resource (sub: resourceId) and expires in 5 minutes.
 * React Query staleTime of 4 minutes ensures it is refreshed before expiry.
 *
 * Use the returned token to construct a URL:
 *   `${baseUrl}/api/resources/${id}?token=${token}`
 */
export function useMediaToken(id: ResourceId): UseMediaTokenResult {
  const resources = useResources();
  const { data, isLoading } = resources.mediaToken.useQuery(id);
  return {
    token: data?.token,
    loading: isLoading,
  };
}
