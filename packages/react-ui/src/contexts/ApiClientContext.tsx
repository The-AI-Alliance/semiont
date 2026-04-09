'use client';

import { createContext, useContext, ReactNode, useMemo } from 'react';
import { baseUrl } from '@semiont/core';
import { SemiontApiClient, type TokenRefresher } from '@semiont/api-client';
import { useEventBus } from './EventBusContext';

const ApiClientContext = createContext<SemiontApiClient | undefined>(undefined);

export interface ApiClientProviderProps {
  baseUrl: string;
  /**
   * Optional 401-recovery hook. If provided, the api-client will retry
   * requests once with a fresh token when a 401 is encountered. The
   * frontend's protected layouts pass `useKnowledgeBaseSession().refreshActive`
   * here so the api-client can transparently recover from expired access tokens.
   */
  tokenRefresher?: TokenRefresher;
  children: ReactNode;
}

/**
 * Provider for API client — must be nested inside EventBusProvider.
 * The client is re-created when the baseUrl changes (workspace switch).
 * The EventBus is taken from EventBusContext so client and UI components
 * share the same workspace-scoped bus.
 */
export function ApiClientProvider({
  baseUrl: url,
  tokenRefresher,
  children,
}: ApiClientProviderProps) {
  const eventBus = useEventBus();

  const client = useMemo(
    () => new SemiontApiClient({
      baseUrl: baseUrl(url),
      eventBus,
      // Use no timeout in test environment to avoid AbortController issues with ky + vitest
      ...(process.env.NODE_ENV !== 'test' && { timeout: 30000 }),
      ...(tokenRefresher && { tokenRefresher }),
    }),
    [url, eventBus, tokenRefresher]
  );

  return (
    <ApiClientContext.Provider value={client}>
      {children}
    </ApiClientContext.Provider>
  );
}

/**
 * Hook to access the stateless API client singleton
 * Must be used within an ApiClientProvider
 * @returns Stateless SemiontApiClient instance
 */
export function useApiClient(): SemiontApiClient {
  const context = useContext(ApiClientContext);

  if (context === undefined) {
    throw new Error('useApiClient must be used within an ApiClientProvider');
  }

  return context;
}
