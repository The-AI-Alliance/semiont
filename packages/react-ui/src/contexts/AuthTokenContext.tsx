'use client';

/**
 * Auth Token Context — exposes the current access token as a BehaviorSubject.
 *
 * Stores the token in a BehaviorSubject so consumers (most importantly
 * SemiontApiClient) can subscribe to it and react to changes without React
 * being in the loop. The token prop is the source of truth — the provider
 * syncs it into the subject on every render, but the subject identity is
 * stable across renders.
 */

import { createContext, useContext, useMemo, useEffect, ReactNode } from 'react';
import { BehaviorSubject } from 'rxjs';
import type { AccessToken } from '@semiont/core';

const AuthTokenContext = createContext<BehaviorSubject<AccessToken | null> | undefined>(undefined);

export interface AuthTokenProviderProps {
  token: string | null;
  children: ReactNode;
}

export function AuthTokenProvider({ token, children }: AuthTokenProviderProps) {
  // Stable BehaviorSubject across renders — consumers subscribe once.
  const token$ = useMemo(
    () => new BehaviorSubject<AccessToken | null>((token as AccessToken | null) ?? null),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Sync the prop into the subject. React drives the value; the subject
  // delivers it to subscribers outside the React tree.
  useEffect(() => {
    const next = (token as AccessToken | null) ?? null;
    if (token$.getValue() !== next) {
      token$.next(next);
    }
  }, [token, token$]);

  return (
    <AuthTokenContext.Provider value={token$}>
      {children}
    </AuthTokenContext.Provider>
  );
}

/**
 * Access the current token synchronously (current BehaviorSubject value).
 * Re-reads on each call but does NOT subscribe — components that need to
 * re-render on token changes should subscribe to `useAuthToken$()` directly.
 */
export function useAuthToken(): string | null {
  const context = useContext(AuthTokenContext);
  if (context === undefined) {
    throw new Error('useAuthToken must be used within an AuthTokenProvider');
  }
  return context.getValue();
}

/**
 * Access the token as a BehaviorSubject — for integrations that subscribe
 * to token changes (e.g. SemiontApiClient's bus actor).
 */
export function useAuthToken$(): BehaviorSubject<AccessToken | null> {
  const context = useContext(AuthTokenContext);
  if (context === undefined) {
    throw new Error('useAuthToken$ must be used within an AuthTokenProvider');
  }
  return context;
}
