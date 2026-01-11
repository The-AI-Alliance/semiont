'use client';

import { createContext, useContext, ReactNode } from 'react';
import type { SessionManager } from '../types/SessionManager';

const SessionContext = createContext<SessionManager | null>(null);

/**
 * Provider Pattern: Accepts SessionManager implementation as prop
 * and makes it available to child components via Context.
 *
 * Apps provide their own implementation (next-auth, custom auth, etc.)
 * and pass it to this provider at the root level.
 *
 * @example
 * ```tsx
 * // In app root
 * const sessionManager = useSessionManager(); // App's implementation
 *
 * <SessionProvider sessionManager={sessionManager}>
 *   <App />
 * </SessionProvider>
 * ```
 */
export function SessionProvider({
  sessionManager,
  children
}: {
  sessionManager: SessionManager;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={sessionManager}>
      {children}
    </SessionContext.Provider>
  );
}

/**
 * Hook to access SessionManager from Context
 * Components use this hook to access session state and expiry information
 */
export function useSessionContext() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSessionContext must be used within SessionProvider');
  }
  return context;
}