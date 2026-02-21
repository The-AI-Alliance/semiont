'use client';

import { createContext, useContext, ReactNode, useMemo } from 'react';
import { baseUrl } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';

const ApiClientContext = createContext<SemiontApiClient | undefined>(undefined);

export interface ApiClientProviderProps {
  baseUrl: string;
  children: ReactNode;
}

/**
 * Provider for API client - creates a stateless singleton client
 * The client instance never changes (no token dependency)
 * Auth tokens are passed per-request via useAuthToken() in calling code
 */
export function ApiClientProvider({
  baseUrl: url,
  children,
}: ApiClientProviderProps) {
  // Client created once and never recreated (no token dependency)
  const client = useMemo(
    () => new SemiontApiClient({
      baseUrl: baseUrl(url),
      // Use no timeout in test environment to avoid AbortController issues with ky + vitest
      ...(process.env.NODE_ENV !== 'test' && { timeout: 30000 }),
    }),
    [url] // Only baseUrl in deps, token removed
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
