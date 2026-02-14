import { useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { SemiontApiClient, baseUrl, accessToken } from '@semiont/api-client';
import type { ApiClientManager } from '@semiont/react-ui';

/**
 * Frontend implementation of ApiClientManager
 * Uses next-auth session to create authenticated API client
 */
export function useApiClientManager(): ApiClientManager {
  const { data: session } = useSession();

  return useMemo(() => {
    if (!session?.backendToken) {
      return null;
    }

    return new SemiontApiClient({
      baseUrl: baseUrl(''), // Empty string = relative URLs, routing layer handles routing
      accessToken: accessToken(session.backendToken),
      // Use no timeout in test environment to avoid AbortController issues with ky + vitest
      ...(process.env.NODE_ENV !== 'test' && { timeout: 30000 }),
    });
  }, [session?.backendToken]);
}
