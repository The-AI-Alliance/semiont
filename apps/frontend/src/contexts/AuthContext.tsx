import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { components } from '@semiont/core';
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
  const [isLoading, setIsLoading] = useState(false);

  const activeKbId = activeKnowledgeBase?.id ?? null;

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

    // Validate the token by calling /api/users/me
    setIsLoading(true);
    const origin = kbBackendUrl(activeKnowledgeBase);
    fetch(`${origin}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => {
        if (!res.ok) throw new Error('Token invalid');
        return res.json();
      })
      .then((data) => {
        setSessionState({ token, user: data });
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
