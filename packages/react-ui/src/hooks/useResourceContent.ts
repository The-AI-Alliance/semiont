import { useEffect } from 'react';
import type { ResourceUri } from '@semiont/core';
import { getPrimaryMediaType } from '@semiont/api-client';
import { useToast } from '../components/Toast';
import { useResources } from '../lib/api-hooks';
import type { components } from '@semiont/core';

type SemiontResource = components['schemas']['ResourceDescriptor'];

export interface UseResourceContentResult {
  content: string;
  loading: boolean;
}

/**
 * Hook to load resource content (representation)
 *
 * Fetches the primary representation of a resource based on its media type.
 * Uses React Query for caching, deduplication, and consistent loading state.
 */
export function useResourceContent(
  rUri: ResourceUri,
  resource: SemiontResource
): UseResourceContentResult {
  const { showError } = useToast();
  const resources = useResources();
  const mediaType = getPrimaryMediaType(resource) || 'text/plain';

  const { data, isLoading, error } = resources.representation.useQuery(rUri, mediaType);

  useEffect(() => {
    if (error) {
      console.error('Failed to fetch representation:', error);
      showError('Failed to load resource representation');
    }
  }, [error, showError]);

  return {
    content: data ?? '',
    loading: isLoading,
  };
}
