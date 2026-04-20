'use client';

import { createContext, useContext, ReactNode, useMemo } from 'react';
import { BehaviorSubject } from 'rxjs';
import { baseUrl, EventBus, type AccessToken } from '@semiont/core';
import { SemiontApiClient, type TokenRefresher } from '@semiont/api-client';

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
 * Provider for API client. The client is re-created when the baseUrl changes
 * (workspace switch). The token BehaviorSubject is owned by this provider —
 * callers that need to drive the token should use SemiontSession (which owns
 * its own client). The EventBus is owned by this provider and torn down
 * with it.
 */
export function ApiClientProvider({
  baseUrl: url,
  tokenRefresher,
  children,
}: ApiClientProviderProps) {
  const client = useMemo(
    () => new SemiontApiClient({
      baseUrl: baseUrl(url),
      eventBus: new EventBus(),
      token$: new BehaviorSubject<AccessToken | null>(null),
      // Use no timeout in test environment to avoid AbortController issues with ky + vitest
      ...(process.env.NODE_ENV !== 'test' && { timeout: 30000 }),
      ...(tokenRefresher && { tokenRefresher }),
    }),
    [url, tokenRefresher]
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
