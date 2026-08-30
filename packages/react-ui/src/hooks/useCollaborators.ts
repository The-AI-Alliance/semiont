import { useEffect, useState } from 'react';
import type { CollaboratorEntry } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

export interface UseCollaboratorsResult {
  collaborators: CollaboratorEntry[];
  loading: boolean;
  error: Error | null;
}

/**
 * The KB's collaborator roster — its declared software agents, each with the
 * job types it serves and, when discovery could answer, its model's context and
 * output ceilings (INFERENCE-LIMITS-EXPOSURE).
 *
 * Takes the client explicitly rather than reaching for `useSemiont()`, matching
 * `useMediaToken(client)`: a bring-your-own-session host can use it with a bare
 * session, and the batteries-included page passes `session.client`.
 *
 * SUBSCRIBES rather than fetching once. `browse.agents()` is a `CacheObservable`
 * whose only refresh triggers are `bus:resume-gap` and an explicit `fresh()` —
 * a gateway restart with a changed roster necessarily presents as an SSE gap, so
 * a one-shot read would pin the UI to a roster that no longer exists. Awaiting
 * it instead would also force a network round trip on every mount, which is
 * exactly what the cache exists to avoid.
 *
 * `error` is surfaced but empty-on-failure is the display contract: a roster
 * that cannot be read shows as no roster, never as a broken panel.
 */
export function useCollaborators(client: SemiontClient | null): UseCollaboratorsResult {
  const [collaborators, setCollaborators] = useState<CollaboratorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client) {
      // No client, no roster — and not "loading" either, or a host without a
      // session would spin forever.
      setCollaborators([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const sub = client.browse.agents().subscribe({
      next: (state) => {
        // The three states are exhaustive by construction (CACHE-CONTRACT);
        // `pending` deliberately leaves the previous roster on screen rather
        // than blanking it during a revalidation.
        if (state.status === 'ready') {
          setCollaborators(state.value);
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

  return { collaborators, loading, error };
}
