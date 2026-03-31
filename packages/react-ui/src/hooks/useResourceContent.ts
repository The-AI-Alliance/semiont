import { useEffect } from 'react';
import type { ResourceId } from '@semiont/core';
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
 * Hook to load text resource content (representation)
 *
 * Fetches and decodes the primary text representation of a resource.
 * Only for text types (text/plain, text/markdown).
 * Binary types (image/*, application/pdf) use useMediaToken instead.
 */
export function useResourceContent(
  rUri: ResourceId,
  resource: SemiontResource,
  enabled = true
): UseResourceContentResult {
  const { showError } = useToast();
  const resources = useResources();
  const mediaType = enabled ? (getPrimaryMediaType(resource) || 'text/plain') : '';

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
