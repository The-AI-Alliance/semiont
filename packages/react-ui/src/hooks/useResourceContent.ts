import { useEffect, useState } from 'react';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import { getPrimaryMediaType, decodeWithCharset } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

export interface UseResourceContentResult {
  content: string;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetch + decode a resource's primary representation from a bare client — the
 * content sibling of `useResourceLoader`/`useMediaToken` (bring-your-own-client;
 * `null` → idle). Headless: errors are RETURNED, never toasted — the host
 * decides chrome (the Browser page toasts; an embedded host may render inline
 * or ignore). `enabled=false` fetches nothing (the binary/media-token path).
 */
export function useResourceContent(
  client: SemiontClient | null,
  rUri: ResourceId,
  resource: ResourceDescriptor,
  enabled = true
): UseResourceContentResult {
  const mediaType = enabled ? (getPrimaryMediaType(resource) || 'text/plain') : '';

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !enabled || !mediaType) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.browse.resourceRepresentation(rUri).then(({ data, contentType }) => {
      if (cancelled) return;
      setContent(decodeWithCharset(data, contentType));
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [client, rUri, mediaType, enabled]);

  return { content, loading, error };
}
