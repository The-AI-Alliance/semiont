import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { SemiontApiClient } from '@semiont/api-client';
import type { components } from '@semiont/core';
import { baseUrl } from '@semiont/core';

type UserInfo = components['schemas']['UserResponse'];

export interface AuthSession {
  token: string;
  user: UserInfo;
}

interface AuthContextValue {
  session: AuthSession | null;
  isLoading: boolean;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ backendUrl: backendUrlProp, children }: { backendUrl: string; children: React.ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    setSessionState(null);
    const client = new SemiontApiClient({ baseUrl: baseUrl(backendUrlProp) });
    client.getMe()
      .then((data) => {
        setSessionState({ token: data.token, user: data });
      })
      .catch(() => {
        setSessionState(null);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const setSession = useCallback((s: AuthSession) => {
    setSessionState(s);
  }, []);

  const clearSession = useCallback(() => {
    setSessionState(null);
  }, []);

  const value = useMemo(
    () => ({ session, isLoading, setSession, clearSession }),
    [session, isLoading, setSession, clearSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

const NO_AUTH: AuthContextValue = {
  session: null,
  isLoading: false,
  setSession: () => {},
  clearSession: () => {},
};

export function useAuthContext(): AuthContextValue {
  return useContext(AuthContext) ?? NO_AUTH;
}
