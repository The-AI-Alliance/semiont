/**
 * useStoreTokenSync — keeps observable store token getters in sync with auth
 *
 * Call once near the workspace root (inside both ApiClientProvider and AuthTokenProvider).
 * Ensures stores can make authenticated fetches as the token changes.
 *
 * @example
 * ```tsx
 * function GlobalEventsConnector() {
 *   useStoreTokenSync();
 *   useGlobalEvents();
 *   return null;
 * }
 * ```
 */

import { useEffect, useRef } from 'react';
import { accessToken } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';

export function useStoreTokenSync(): void {
  const semiont = useApiClient();
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; });

  useEffect(() => {
    const getter = () => tokenRef.current ? accessToken(tokenRef.current) : undefined;
    semiont.setTokenGetter(getter);
  }, [semiont]);
}
