import { useEffect, useState } from 'react';
import type { ResourceId } from '@semiont/core';
import { accessToken } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';

export interface UseMediaTokenResult {
  token: string | undefined;
  loading: boolean;
}

export function useMediaToken(id: ResourceId): UseMediaTokenResult {
  const semiont = useApiClient();
  const authToken = useAuthToken();
  const [token, setToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!semiont || !id) { setLoading(false); return; }
    setLoading(true);
    semiont.getMediaToken(id, { auth: authToken ? accessToken(authToken) : undefined })
      .then(({ token: t }) => { setToken(t); setLoading(false); })
      .catch(() => { setLoading(false); });

    const refreshInterval = setInterval(() => {
      semiont.getMediaToken(id, { auth: authToken ? accessToken(authToken) : undefined })
        .then(({ token: t }) => setToken(t))
        .catch(() => {});
    }, 4 * 60 * 1000);

    return () => clearInterval(refreshInterval);
  }, [semiont, id, authToken]);

  return { token, loading };
}
