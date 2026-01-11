'use client';

import { useState, useEffect, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import type { SessionManager } from '@semiont/react-ui';

/**
 * Hook that provides SessionManager implementation using next-auth
 * This is the app-level implementation that gets passed to SessionProvider as props
 */
export function useSessionManager(): SessionManager {
  const { data: session } = useSession();
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);

  // Parse JWT token safely to extract expiration
  useEffect(() => {
    if (session?.backendToken) {
      try {
        const parts = session.backendToken.split('.');
        if (parts.length === 3 && parts[1]) {
          const payload = JSON.parse(atob(parts[1]));
          if (payload.exp) {
            setExpiresAt(new Date(payload.exp * 1000));
          }
        }
      } catch (error) {
        console.error('Failed to parse token expiration:', error);
        setExpiresAt(null);
      }
    } else {
      setExpiresAt(null);
    }
  }, [session]);

  const value = useMemo(() => {
    const now = Date.now();
    const timeUntilExpiry = expiresAt ? expiresAt.getTime() - now : null;

    return {
      isAuthenticated: !!session?.backendToken,
      expiresAt,
      timeUntilExpiry,
      isExpiringSoon: timeUntilExpiry !== null && timeUntilExpiry < 5 * 60 * 1000 && timeUntilExpiry > 0
    };
  }, [session, expiresAt]);

  return value;
}
