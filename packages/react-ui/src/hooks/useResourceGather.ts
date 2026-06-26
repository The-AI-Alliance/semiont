import { useState, useCallback } from 'react';
import { resourceId as toResourceId, type GatheredContext } from '@semiont/core';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';

export interface ResourceGatherOptions {
  depth?: number;
  maxResources?: number;
  includeContent?: boolean;
  includeSummary?: boolean;
  /** Entity types to exclude from the gather's semantic recall (e.g. ['Question']). */
  excludeEntityTypes?: string[];
}

export interface UseResourceGatherResult {
  context: GatheredContext | null;
  loading: boolean;
  error: Error | null;
  /** Run a resource gather (`gather.resource`) and store the result. */
  gather: (resourceId: string, options?: ResourceGatherOptions) => Promise<void>;
  reset: () => void;
}

/**
 * Drives a whole-resource gather (`client.gather.resource`, a Promise — no progress
 * stream) into React state. The home for the GENERATE-FROM-BUTTON resource-gather flow.
 */
export function useResourceGather(): UseResourceGatherResult {
  const client = useObservable(useSemiont().activeSession$)?.client;
  const [context, setContext] = useState<GatheredContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const gather = useCallback(async (id: string, options?: ResourceGatherOptions) => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const ctx = await client.gather.resource(toResourceId(id), options);
      setContext(ctx);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [client]);

  const reset = useCallback(() => {
    setContext(null);
    setError(null);
    setLoading(false);
  }, []);

  return { context, loading, error, gather, reset };
}
