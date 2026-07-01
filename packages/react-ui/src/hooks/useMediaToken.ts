import { useEffect, useState } from 'react';
import type { ResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

export interface UseMediaTokenResult {
  token: string | undefined;
  loading: boolean;
}

/**
 * Mint (and periodically refresh) a short-lived authed media token for a
 * resource — the query param that makes `<img>` / PDF URLs load. Takes the
 * client explicitly (not `useSemiont()`), so a bring-your-own-session host can
 * use it with a bare session; the batteries-included page passes `session.client`.
 */
export function useMediaToken(client: SemiontClient | null, id: ResourceId): UseMediaTokenResult {
  const [token, setToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!client || !id) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    client.auth!.mediaToken(id)
      .then(({ token: t }) => {
        if (cancelled) return;
        setToken(t);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });

    const refreshInterval = setInterval(() => {
      client.auth!.mediaToken(id)
        .then(({ token: t }) => { if (!cancelled) setToken(t); })
        .catch(() => {});
    }, 4 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
    };
  }, [client, id]);

  return { token, loading };
}
