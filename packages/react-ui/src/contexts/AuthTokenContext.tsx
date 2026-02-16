'use client';

/**
 * Auth Token Context - Manages authentication token lifecycle
 *
 * Separation of concerns:
 * - Auth token management is separate from API client
 * - API client is stateless (doesn't store token)
 * - Token flows through as immutable data
 *
 * Following functional programming principles:
 * - Pure token access (no side effects)
 * - Immutable data flow
 * - Single responsibility (only manages tokens)
 */

import { createContext, useContext, ReactNode } from 'react';

/**
 * Auth token manager interface
 *
 * Apps must provide an implementation that:
 * - Returns current access token (null if not authenticated)
 * - Optionally supports token refresh
 */
export interface AuthTokenManager {
  /**
   * Get current access token
   * @returns Access token string, or null if not authenticated
   */
  getToken: () => string | null;

  /**
   * Optional: Refresh token if needed
   * For future token refresh logic
   */
  refreshToken?: () => Promise<string>;
}

const AuthTokenContext = createContext<AuthTokenManager | undefined>(undefined);

export interface AuthTokenProviderProps {
  tokenManager: AuthTokenManager;
  children: ReactNode;
}

/**
 * Provider for auth token management
 * Apps must provide an AuthTokenManager implementation
 */
export function AuthTokenProvider({
  tokenManager,
  children,
}: AuthTokenProviderProps) {
  return (
    <AuthTokenContext.Provider value={tokenManager}>
      {children}
    </AuthTokenContext.Provider>
  );
}

/**
 * Hook to get current auth token
 *
 * Pure function - just reads current token value
 * No side effects, no subscriptions, no state
 *
 * @returns Current access token (null if not authenticated)
 * @throws Error if used outside AuthTokenProvider
 */
export function useAuthToken(): string | null {
  const context = useContext(AuthTokenContext);

  if (context === undefined) {
    throw new Error('useAuthToken must be used within an AuthTokenProvider');
  }

  return context.getToken();
}
