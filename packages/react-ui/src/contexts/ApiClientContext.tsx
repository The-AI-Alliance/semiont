'use client';

import { createContext, useContext, ReactNode, useMemo } from 'react';
import { baseUrl } from '@semiont/core';
import { SemiontApiClient, type TokenRefresher } from '@semiont/api-client';
import { useEventBus } from './EventBusContext';
import { useAuthToken$ } from './AuthTokenContext';

const ApiClientContext = createContext<SemiontApiClient | undefined>(undefined);

export interface ApiClientProviderProps {
  baseUrl: string;
  /**
   * Optional 401-recovery hook. If provided, the api-client will retry
   * requests once with a fresh token when a 401 is encountered.
   */
  tokenRefresher?: TokenRefresher;
  children: ReactNode;
}

/**
 * Provider for API client — must be nested inside EventBusProvider and
 * AuthTokenProvider. The client is re-created when the baseUrl changes
 * (workspace switch). The EventBus and token BehaviorSubject come from
 * context, so the client reads the current token observably without any
 * React-specific wiring.
 */
export function ApiClientProvider({
  baseUrl: url,
  tokenRefresher,
  children,
}: ApiClientProviderProps) {
  const eventBus = useEventBus();
  const token$ = useAuthToken$();

  const client = useMemo(
    () => new SemiontApiClient({
      baseUrl: baseUrl(url),
      eventBus,
      token$,
      // Use no timeout in test environment to avoid AbortController issues with ky + vitest
      ...(process.env.NODE_ENV !== 'test' && { timeout: 30000 }),
      ...(tokenRefresher && { tokenRefresher }),
    }),
    [url, eventBus, token$, tokenRefresher]
  );

  return (
    <ApiClientContext.Provider value={client}>
      {children}
    </ApiClientContext.Provider>
  );
}

export function useApiClient(): SemiontApiClient {
  const context = useContext(ApiClientContext);
  if (context === undefined) {
    throw new Error('useApiClient must be used within an ApiClientProvider');
  }
  return context;
}
