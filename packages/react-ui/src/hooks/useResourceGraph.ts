import { useEffect, useState } from 'react';
import type { ResourceId, components } from '@semiont/core';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';

type GetResourceResponse = components['schemas']['GetResourceResponse'];

export interface UseResourceGraphResult {
  graph: GetResourceResponse | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetch a resource's full JSON-LD graph — descriptor + annotations + inbound
 * entity references — by dereferencing the LD face via the client's
 * `browse.resourceGraph` (HTTP `GET /resources/:id/jsonld`).
 *
 * Sibling to `useResourceContent` / `useMediaToken`: it owns the
 * session/client access so Views never reach into it. One-shot, uncached,
 * cancellation-guarded; refetches when `id` changes.
 */
export function useResourceGraph(id: ResourceId): UseResourceGraphResult {
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const [graph, setGraph] = useState<GetResourceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!semiont || !id) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    semiont.browse.resourceGraph(id)
      .then((g) => {
        if (cancelled) return;
        setGraph(g);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [semiont, id]);

  return { graph, loading, error };
}
