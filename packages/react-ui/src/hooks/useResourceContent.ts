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

/** A finished fetch, held with the inputs it was made for. */
interface Outcome {
  client: SemiontClient;
  rUri: ResourceId;
  mediaType: string;
  result: { content: string } | { error: Error };
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

  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!client || !enabled) return;
    let cancelled = false;
    client.browse.resourceRepresentation(rUri).then(({ data, contentType }) => {
      if (cancelled) return;
      setOutcome({ client, rUri, mediaType, result: { content: decodeWithCharset(data, contentType) } });
    }).catch((err) => {
      if (cancelled) return;
      setOutcome({ client, rUri, mediaType, result: { error: err instanceof Error ? err : new Error(String(err)) } });
    });

    return () => { cancelled = true; };
  }, [client, rUri, mediaType, enabled]);

  if (!client || !enabled) return { content: undefined, loading: false, error: null };

  // An outcome answers only for the inputs it was fetched for, and that is
  // checked HERE, during render. State cleared in the effect arrives one render
  // late: for that frame the caller is handed the previous resource's content,
  // its error, or "not loading" for a fetch that has not started yet.
  if (
    outcome === null ||
    outcome.client !== client ||
    outcome.rUri !== rUri ||
    outcome.mediaType !== mediaType
  ) {
    return { content: undefined, loading: true, error: null };
  }

  return 'content' in outcome.result
    ? { content: outcome.result.content, loading: false, error: null }
    : { content: undefined, loading: false, error: outcome.result.error };
}
