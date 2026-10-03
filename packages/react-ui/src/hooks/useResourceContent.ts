import { useEffect, useState } from 'react';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import { getPrimaryMediaType, decodeWithCharset } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

export interface UseResourceContentResult {
  /**
   * The decoded text, or `undefined` until it has loaded. A zero-byte document
   * loads as `''`, so "is it loaded?" is `content !== undefined` — never a
   * length check, which gets every empty document wrong.
   */
  content: string | undefined;
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

  const [content, setContent] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // The previous run's content never survives into this one: it belongs to
    // the previous (client, resource, media type), and a caller reading
    // `content !== undefined` must be told about THIS one.
    setContent(undefined);
    setError(null);
    if (!client || !enabled) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
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
