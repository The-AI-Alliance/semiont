import { useState, useEffect, useMemo } from 'react';
import type { SessionManager } from '@semiont/react-ui';
import { useAuth } from '@/hooks/useAuth';

/**
 * Hook that provides SessionManager implementation using AuthContext
 */
export function useSessionManager(): SessionManager {
  const { token } = useAuth();
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);

  useEffect(() => {
    if (token) {
      try {
        const parts = token.split('.');
        if (parts.length === 3 && parts[1]) {
          const payload = JSON.parse(atob(parts[1]));
          if (payload.exp) {
            setExpiresAt(new Date(payload.exp * 1000));
          }
        }
      } catch {
        setExpiresAt(null);
      }
    } else {
      setExpiresAt(null);
    }
  }, [token]);

  return useMemo(() => {
    const now = Date.now();
    const timeUntilExpiry = expiresAt ? expiresAt.getTime() - now : null;

    return {
      isAuthenticated: !!token,
      expiresAt,
      timeUntilExpiry,
      isExpiringSoon: timeUntilExpiry !== null && timeUntilExpiry < 5 * 60 * 1000 && timeUntilExpiry > 0,
    };
  }, [token, expiresAt]);
}
