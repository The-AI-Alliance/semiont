'use client';

/**
 * Auth Token Context - Manages authentication token lifecycle
 *
 * Simple approach: Just pass the token value through context.
 * When the token changes, context updates, components re-render.
 * No complex machinery needed.
 */

import { createContext, useContext, ReactNode } from 'react';

const AuthTokenContext = createContext<string | null | undefined>(undefined);

export interface AuthTokenProviderProps {
  token: string | null;
  children: ReactNode;
}

/**
 * Provider for auth token
 * Pass the current token value - React handles the rest
 */
export function AuthTokenProvider({
  token,
  children,
}: AuthTokenProviderProps) {
  return (
    <AuthTokenContext.Provider value={token}>
      {children}
    </AuthTokenContext.Provider>
  );
}

/**
 * Hook to get current auth token
 *
 * Returns the current token value from context.
 * Re-renders automatically when token changes (normal React behavior).
 *
 * @returns Current access token (null if not authenticated)
 * @throws Error if used outside AuthTokenProvider
 */
export function useAuthToken(): string | null {
  const context = useContext(AuthTokenContext);

  if (context === undefined) {
    throw new Error('useAuthToken must be used within an AuthTokenProvider');
  }

  return context;
}
