import { useSession } from 'next-auth/react';
import type { AuthTokenManager } from '@semiont/react-ui';

/**
 * Frontend implementation of AuthTokenManager
 *
 * Uses next-auth session to provide token.
 * Pure function - just reads session, no side effects.
 *
 * @returns AuthTokenManager that reads from next-auth session
 */
export function useAuthTokenManager(): AuthTokenManager {
  const { data: session } = useSession();

  return {
    getToken: () => session?.backendToken || null,
  };
}
