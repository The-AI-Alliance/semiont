import { useEffect, useState } from 'react';
import type { EngineWithLimits } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

export interface UseEnginesResult {
  engines: EngineWithLimits[];
  loading: boolean;
  error: Error | null;
}

/**
 * The KB's engines — each a provider and a model, with the jobs the KB's
 * Inference document has it used for and, when discovery could answer, its
 * context and output ceilings.
 *
 * Takes the client explicitly rather than reaching for `useSemiont()`, matching
 * `useMediaToken(client)`: a bring-your-own-session host can use it with a bare
 * session, and the batteries-included page passes `session.client`.
 *
 * SUBSCRIBES rather than fetching once. `browse.engines()` is a `CacheObservable`
 * whose only refresh triggers are its stream reopening after a drop and an
 * explicit `fresh()` — a gateway restart with changed engines presents as a
 * drop, so a one-shot read would pin the UI to engines that no longer exist. Awaiting
 * it instead would also force a network round trip on every mount, which is
 * exactly what the cache exists to avoid.
 *
 * `error` is surfaced but empty-on-failure is the display contract: engines
 * that cannot be read show as no engines, never as a broken panel.
 */
export function useEngines(client: SemiontClient | null): UseEnginesResult {
  const [engines, setEngines] = useState<EngineWithLimits[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client) {
      // No client, no engines — and not "loading" either, or a host without a
      // session would spin forever.
      setEngines([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const sub = client.browse.engines().subscribe({
      next: (state) => {
        // The three states are exhaustive by construction (the cache emits
        // pending | ready | failed, and failure is an emission, not a stream
        // error); `pending` deliberately leaves the previous engines on screen
        // rather than blanking them during a revalidation.
        if (state.status === 'ready') {
          setEngines(state.value);
          setLoading(false);
          setError(null);
        } else if (state.status === 'failed') {
          setError(state.error);
          setLoading(false);
        }
      },
      error: (err: unknown) => {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      },
    });

    return () => sub.unsubscribe();
  }, [client]);

  return { engines, loading, error };
}
