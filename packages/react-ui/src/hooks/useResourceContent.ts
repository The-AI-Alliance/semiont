import { useState, useEffect } from 'react';
import type { ResourceUri, ContentFormat } from '@semiont/api-client';
import { getPrimaryMediaType, decodeWithCharset } from '@semiont/api-client';
import { useApiClient } from '../contexts/ApiClientContext';
import { useToast } from '../components/Toast';
import type { components } from '@semiont/api-client';

type SemiontResource = components['schemas']['ResourceDescriptor'];

export interface UseResourceContentResult {
  content: string;
  loading: boolean;
}

/**
 * Hook to load resource content (representation)
 *
 * Fetches the primary representation of a resource based on its media type.
 */
export function useResourceContent(
  rUri: ResourceUri,
  resource: SemiontResource
): UseResourceContentResult {
  const client = useApiClient();
  const { showError } = useToast();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadContent = async () => {
      try {
        const mediaType = getPrimaryMediaType(resource) || 'text/plain';
        const { data } = await client.getResourceRepresentation(rUri, {
          accept: mediaType as ContentFormat,
        });
        const text = decodeWithCharset(data, mediaType);
        setContent(text);
      } catch (error) {
        console.error('Failed to fetch representation:', error);
        showError('Failed to load resource representation');
      } finally {
        setLoading(false);
      }
    };
    loadContent();
  }, [rUri, resource, client, showError]);

  return { content, loading };
}
