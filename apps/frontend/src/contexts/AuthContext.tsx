import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { SemiontApiClient } from '@semiont/api-client';
import type { components } from '@semiont/core';
import { baseUrl, EventBus, accessToken } from '@semiont/core';
import { useKnowledgeBaseContext, kbBackendUrl, getKbToken, isTokenExpired } from './KnowledgeBaseContext';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { activeKnowledgeBase } = useKnowledgeBaseContext();
  const [session, setSessionState] = useState<AuthSession | null>(null);
  // Start loading if there's a stored token to validate
  const activeKbId = activeKnowledgeBase?.id ?? null;
  const [isLoading, setIsLoading] = useState(() => {
    if (!activeKbId) return false;
    const token = getKbToken(activeKbId);
    return !!token && !isTokenExpired(token);
  });

  // When active KB changes, try to restore session from stored token
  useEffect(() => {
    if (!activeKbId || !activeKnowledgeBase) {
      setSessionState(null);
      setIsLoading(false);
      return;
    }

    const token = getKbToken(activeKbId);
    if (!token || isTokenExpired(token)) {
      setSessionState(null);
      setIsLoading(false);
      return;
    }

    // Validate the token by calling getMe via the API client
    setIsLoading(true);
    const client = new SemiontApiClient({
      baseUrl: baseUrl(kbBackendUrl(activeKnowledgeBase)),
      eventBus: new EventBus(),
    });
    client.getMe({ auth: accessToken(token) })
      .then((data) => {
        setSessionState({ token, user: data as UserInfo });
      })
      .catch(() => {
        setSessionState(null);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [activeKbId, activeKnowledgeBase]);

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
