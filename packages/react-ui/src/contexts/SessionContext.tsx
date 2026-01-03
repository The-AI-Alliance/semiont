'use client';

import { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import { useSession } from 'next-auth/react';

interface SessionState {
  isAuthenticated: boolean;
  expiresAt: Date | null;
  timeUntilExpiry: number | null;
  isExpiringSoon: boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
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

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionContext() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSessionContext must be used within SessionProvider');
  }
  return context;
}