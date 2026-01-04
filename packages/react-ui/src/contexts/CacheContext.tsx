'use client';

import React, { createContext, useContext } from 'react';
import type { CacheManager } from '../types/CacheManager';

const CacheContext = createContext<CacheManager | undefined>(undefined);

export interface CacheProviderProps {
  cacheManager: CacheManager;
  children: React.ReactNode;
}

/**
 * Cache Provider
 *
 * Provides cache invalidation capabilities via the Provider Pattern.
 * Apps inject their own CacheManager implementation.
 *
 * Example usage:
 * ```typescript
 * // In app (apps/frontend/src/hooks/useCacheManager.ts)
 * function useCacheManager(): CacheManager {
 *   const queryClient = useQueryClient();
 *
 *   return {
 *     invalidateAnnotations: (rUri) => {
 *       queryClient.invalidateQueries({ queryKey: ['annotations', rUri] });
 *     },
 *     invalidateEvents: (rUri) => {
 *       queryClient.invalidateQueries({ queryKey: ['documents', 'events', rUri] });
 *     }
 *   };
 * }
 *
 * // In app layout
 * const cacheManager = useCacheManager();
 * <CacheProvider cacheManager={cacheManager}>
 *   <YourComponents />
 * </CacheProvider>
 * ```
 */
export function CacheProvider({ cacheManager, children }: CacheProviderProps) {
  return (
    <CacheContext.Provider value={cacheManager}>
      {children}
    </CacheContext.Provider>
  );
}

/**
 * Hook to access the CacheManager
 *
 * @throws Error if used outside CacheProvider
 * @returns CacheManager instance
 */
export function useCacheManager(): CacheManager {
  const context = useContext(CacheContext);
  if (!context) {
    throw new Error('useCacheManager must be used within a CacheProvider');
  }
  return context;
}
