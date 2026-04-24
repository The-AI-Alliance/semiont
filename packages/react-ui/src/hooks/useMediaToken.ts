import { useEffect, useState } from 'react';
import type { ResourceId } from '@semiont/core';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';

export interface UseMediaTokenResult {
  token: string | undefined;
  loading: boolean;
}

export function useMediaToken(id: ResourceId): UseMediaTokenResult {
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const [token, setToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!semiont || !id) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    semiont.getMediaToken(id)
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
      semiont.getMediaToken(id)
        .then(({ token: t }) => { if (!cancelled) setToken(t); })
        .catch(() => {});
    }, 4 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
    };
  }, [semiont, id]);

  return { token, loading };
}
