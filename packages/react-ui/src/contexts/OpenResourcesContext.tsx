'use client';

import React, { createContext, useContext } from 'react';
import type { OpenResourcesManager } from '../types/OpenResourcesManager';

const OpenResourcesContext = createContext<OpenResourcesManager | undefined>(undefined);

/**
 * Provider Pattern: Accepts OpenResourcesManager implementation as prop
 * and makes it available to child components via Context.
 *
 * Apps provide their own implementation (localStorage, sessionStorage, database, etc.)
 * and pass it to this provider at the root level.
 *
 * @example
 * ```tsx
 * // In app root
 * const openResourcesManager = useOpenResourcesManager(); // App's implementation
 *
 * <OpenResourcesProvider openResourcesManager={openResourcesManager}>
 *   <App />
 * </OpenResourcesProvider>
 * ```
 */
export function OpenResourcesProvider({
  openResourcesManager,
  children
}: {
  openResourcesManager: OpenResourcesManager;
  children: React.ReactNode;
}) {
  return (
    <OpenResourcesContext.Provider value={openResourcesManager}>
      {children}
    </OpenResourcesContext.Provider>
  );
}

/**
 * Hook to access OpenResourcesManager from Context
 * Components use this hook to access open resources functionality
 */
export function useOpenResources(): OpenResourcesManager {
  const context = useContext(OpenResourcesContext);
  if (context === undefined) {
    throw new Error('useOpenResources must be used within an OpenResourcesProvider');
  }
  return context;
}