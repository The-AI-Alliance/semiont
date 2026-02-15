'use client';

import { createContext, useContext, ReactNode } from 'react';
import type { ApiClientManager } from '../types/ApiClientManager';

const ApiClientContext = createContext<ApiClientManager | undefined>(undefined);

export interface ApiClientProviderProps {
  apiClientManager: ApiClientManager;
  children: ReactNode;
}

/**
 * Provider for API client management
 * Apps must provide an ApiClientManager implementation
 */
export function ApiClientProvider({
  apiClientManager,
  children,
}: ApiClientProviderProps) {
  return (
    <ApiClientContext.Provider value={apiClientManager}>
      {children}
    </ApiClientContext.Provider>
  );
}

/**
 * Hook to access the API client
 * Must be used within an ApiClientProvider
 * @returns API client instance (null if not authenticated)
 */
export function useApiClient() {
  const context = useContext(ApiClientContext);

  if (context === undefined) {
    throw new Error('useApiClient must be used within an ApiClientProvider');
  }

  return context;
}
