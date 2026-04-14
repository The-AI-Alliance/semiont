/**
 * KnowledgeBaseSessionContext — single source of truth for "which KB and
 * what's the session against it."
 *
 * This provider merges what used to be three separate concerns in the
 * frontend (KnowledgeBaseProvider + KnowledgeBaseAuthBridge + AuthProvider)
 * plus the library-side SessionProvider, into one coherent unit.
 *
 * Why merged: a session in this app is always a session against a specific
 * KB. There is no auth without a KB. Switching KBs means switching sessions
 * atomically.
 *
 * What it owns:
 *   - The list of configured KBs (persisted to localStorage)
 *   - Which KB is currently active (persisted to localStorage)
 *   - The validated session (token + user) for the active KB
 *   - The "session expired" and "permission denied" flags that drive the modals
 *   - JWT expiry derivations (for the session-timer UI)
 *   - Mount-time validation flow with manual 401 recovery
 *   - Proactive refresh: a timer that fires before the access token expires
 *   - Cross-tab sync: when another tab refreshes or signs out, this tab updates
 *
 * Implementation is split across the `knowledge-base-session/` directory:
 *   - `storage.ts` — localStorage shape, JWT helpers, KB list helpers
 *   - `refresh.ts` — `performRefresh` and the in-flight Promise dedup map
 *   - `notify.ts` — module-scoped notify functions and the register helper
 *
 * Mounting: must be inside `EventBusProvider` and `TranslationProvider` (it
 * uses neither, but the modals it sits next to do). It does NOT depend on
 * any other library context. Mount it inside the protected layout boundary.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SemiontApiClient, APIError } from '@semiont/api-client';
import { baseUrl, EventBus, accessToken } from '@semiont/core';
import type { components } from '@semiont/core';
import type {
  KnowledgeBase,
  NewKnowledgeBase,
} from '../types/knowledge-base';
import {
  ACTIVE_KEY,
  REFRESH_BEFORE_EXP_MS,
  clearStoredSession,
  generateKbId,
  getStoredSession,
  isJwtExpired,
  kbBackendUrl,
  loadKnowledgeBases,
  parseJwtExpiry,
  saveKnowledgeBases,
  sessionKey,
  setStoredSession,
} from './knowledge-base-session/storage';
import { performRefresh } from './knowledge-base-session/refresh';
import { registerAuthNotifyHandlers } from './knowledge-base-session/notify';
import type { StoredSession } from './knowledge-base-session/storage';

type UserInfo = components['schemas']['UserResponse'];

export interface AuthSession {
  token: string;
  user: UserInfo;
}

// Re-export the public surface so consumers can keep importing from this module
export {
  defaultProtocol,
  isValidHostname,
  kbBackendUrl,
  getKbSessionStatus,
} from './knowledge-base-session/storage';
export type { StoredSession } from './knowledge-base-session/storage';
export {
  notifySessionExpired,
  notifyPermissionDenied,
} from './knowledge-base-session/notify';

// ---------- Context value ----------

interface KnowledgeBaseSessionValue {
  // KB list
  knowledgeBases: KnowledgeBase[];
  activeKnowledgeBase: KnowledgeBase | null;

  // Session state for the active KB
  session: AuthSession | null;
  isLoading: boolean;

  // Derived auth fields (memoized off `session.user`)
  user: UserInfo | null;
  token: string | null;
  isAuthenticated: boolean;
  hasValidBackendToken: boolean;
  isFullyAuthenticated: boolean;
  displayName: string;
  avatarUrl: string | null;
  userDomain: string | undefined;
  isAdmin: boolean;
  isModerator: boolean;

  // JWT expiry (derived from session.token)
  expiresAt: Date | null;

  // Modal-driving flags
  sessionExpiredAt: number | null;
  sessionExpiredMessage: string | null;
  permissionDeniedAt: number | null;
  permissionDeniedMessage: string | null;

  // Mutations
  addKnowledgeBase: (kb: NewKnowledgeBase, access: string, refresh: string) => KnowledgeBase;
  removeKnowledgeBase: (id: string) => void;
  setActiveKnowledgeBase: (id: string) => void;
  updateKnowledgeBase: (id: string, updates: Partial<KnowledgeBase>) => void;
  /** Re-auth on an existing KB: store the new tokens and refresh the session. */
  signIn: (id: string, access: string, refresh: string) => void;
  /** Sign out of a KB: clear its stored tokens. If it's the active KB, clear in-memory session too. */
  signOut: (id: string) => void;

  /**
   * Refresh the active KB's access token. Returns the new access token, or
   * null if no refresh token is available or the refresh failed. Concurrent
   * calls deduplicate via an in-flight Promise per KB. Used by the api-client's
   * 401-recovery hook and by the proactive refresh timer.
   */
  refreshActive: () => Promise<string | null>;

  // Modal acks
  acknowledgeSessionExpired: () => void;
  acknowledgePermissionDenied: () => void;
}

/**
 * Raw context export. Exposed for test utilities that need to construct
 * a mock provider without going through localStorage and JWT validation.
 * Production code should always use {@link useKnowledgeBaseSession} instead.
 */
export const KnowledgeBaseSessionContext = createContext<KnowledgeBaseSessionValue | undefined>(undefined);

export type { KnowledgeBaseSessionValue };

// ---------- Provider ----------

export function KnowledgeBaseSessionProvider({ children }: { children: React.ReactNode }) {
  // KB list and active selection
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>(() => loadKnowledgeBases());
  const [activeKnowledgeBaseId, setActiveKnowledgeBaseId] = useState<string | null>(() => {
    const saved = localStorage.getItem(ACTIVE_KEY);
    const loaded = loadKnowledgeBases();
    if (saved && loaded.some(kb => kb.id === saved)) return saved;
    return loaded[0]?.id ?? null;
  });

  // Session state for the active KB
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(() => {
    const id = activeKnowledgeBaseId;
    if (!id) return false;
    const stored = getStoredSession(id);
    if (!stored) return false;
    // We'll either validate (if access fresh) or refresh (if refresh available)
    return !isJwtExpired(stored.access) || stored.refresh != null;
  });

  // Modal flags
  const [sessionExpiredAt, setSessionExpiredAt] = useState<number | null>(null);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);
  const [permissionDeniedAt, setPermissionDeniedAt] = useState<number | null>(null);
  const [permissionDeniedMessage, setPermissionDeniedMessage] = useState<string | null>(null);

  // Persist KB list and active id
  useEffect(() => {
    saveKnowledgeBases(knowledgeBases);
  }, [knowledgeBases]);

  useEffect(() => {
    if (activeKnowledgeBaseId) {
      localStorage.setItem(ACTIVE_KEY, activeKnowledgeBaseId);
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }, [activeKnowledgeBaseId]);

  const activeKnowledgeBase = useMemo(
    () => knowledgeBases.find(kb => kb.id === activeKnowledgeBaseId) ?? null,
    [knowledgeBases, activeKnowledgeBaseId]
  );

  // Refs for cross-effect coordination
  const activeKbRef = useRef<KnowledgeBase | null>(activeKnowledgeBase);
  useEffect(() => {
    activeKbRef.current = activeKnowledgeBase;
  }, [activeKnowledgeBase]);

  const proactiveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Schedule a one-shot timer that fires `REFRESH_BEFORE_EXP_MS` before the
   * given access token expires. Cancels any prior pending timer.
   */
  const scheduleProactiveRefresh = useCallback((accessTokenStr: string) => {
    if (proactiveRefreshTimerRef.current) {
      clearTimeout(proactiveRefreshTimerRef.current);
      proactiveRefreshTimerRef.current = null;
    }
    const expiresAt = parseJwtExpiry(accessTokenStr);
    if (!expiresAt) return;
    const refreshAt = expiresAt.getTime() - REFRESH_BEFORE_EXP_MS;
    const delay = Math.max(0, refreshAt - Date.now());
    proactiveRefreshTimerRef.current = setTimeout(() => {
      proactiveRefreshTimerRef.current = null;
      // Fire-and-forget: refreshActive captures activeKbRef and updates state
      refreshActiveRef.current?.();
    }, delay);
  }, []);

  // refreshActive needs to be stable across renders for the api-client wiring
  // and also needs to read fresh activeKnowledgeBase via the ref. We define
  // the function via a ref so callers can capture a stable reference.
  const refreshActiveRef = useRef<(() => Promise<string | null>) | null>(null);
  const refreshActive = useCallback(async (): Promise<string | null> => {
    const kb = activeKbRef.current;
    if (!kb) return null;
    const newAccess = await performRefresh(kb);
    if (newAccess) {
      // Update the in-memory session token so consumers see the new value
      setSession(prev => (prev ? { ...prev, token: newAccess } : prev));
      scheduleProactiveRefresh(newAccess);
    } else {
      // Refresh failed — surface the modal
      setSession(null);
      clearStoredSession(kb.id);
      setSessionExpiredMessage('Your session has expired. Please sign in again.');
      setSessionExpiredAt(Date.now());
      if (proactiveRefreshTimerRef.current) {
        clearTimeout(proactiveRefreshTimerRef.current);
        proactiveRefreshTimerRef.current = null;
      }
    }
    return newAccess;
  }, [scheduleProactiveRefresh]);
  refreshActiveRef.current = refreshActive;

  // Mount-time validation. This is the only 401-handling path that does NOT
  // go through the api-client's `tokenRefresher` hook. Two structural reasons:
  //
  //   1. ApiClientProvider hasn't mounted yet — the protected layout mounts
  //      ApiClientProvider as a CHILD of this provider, so at validation time
  //      the configured api-client (the one with `tokenRefresher`) doesn't
  //      exist yet.
  //
  //   2. Even if it did, having the api-client silently recover would mean
  //      this effect would never see the 401. But this effect is what BUILDS
  //      the session — it needs to know whether validation succeeded so it
  //      can either set `session = { token, user }` or surface the modal.
  //
  // So this effect uses a fresh throwaway api-client (no refresher) and
  // handles 401 manually: try one refresh, retry getMe with the new token,
  // surface the modal only if both fail. The duplication with the api-client's
  // beforeRetry hook is structural — do not try to consolidate them.
  useEffect(() => {
    if (!activeKnowledgeBase) {
      setSession(null);
      setIsLoading(false);
      return;
    }

    const stored = getStoredSession(activeKnowledgeBase.id);
    if (!stored) {
      setSession(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const validate = async (tokenToUse: string) => {
      const client = new SemiontApiClient({
        baseUrl: baseUrl(kbBackendUrl(activeKnowledgeBase)),
        eventBus: new EventBus(),
      });
      try {
        const data = await client.getMe({ auth: accessToken(tokenToUse) });
        if (cancelled) return;
        setSession({ token: tokenToUse, user: data as UserInfo });
        scheduleProactiveRefresh(tokenToUse);
      } catch (error) {
        if (cancelled) return;
        setSession(null);
        if (error instanceof APIError && error.status === 401) {
          // Try one refresh on 401 from getMe before surfacing the modal
          const refreshed = await performRefresh(activeKnowledgeBase);
          if (cancelled) return;
          if (refreshed) {
            return validate(refreshed);
          }
          clearStoredSession(activeKnowledgeBase.id);
          setSessionExpiredMessage('Your session has expired. Please sign in again.');
          setSessionExpiredAt(Date.now());
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    setIsLoading(true);

    if (isJwtExpired(stored.access)) {
      (async () => {
        const refreshed = await performRefresh(activeKnowledgeBase);
        if (cancelled) return;
        if (refreshed) {
          await validate(refreshed);
        } else {
          setSession(null);
          clearStoredSession(activeKnowledgeBase.id);
          setIsLoading(false);
        }
      })();
    } else {
      validate(stored.access);
    }

    return () => {
      cancelled = true;
    };
  }, [activeKnowledgeBase, scheduleProactiveRefresh]);

  // Cancel proactive refresh timer on unmount
  useEffect(() => {
    return () => {
      if (proactiveRefreshTimerRef.current) {
        clearTimeout(proactiveRefreshTimerRef.current);
        proactiveRefreshTimerRef.current = null;
      }
    };
  }, []);

  // Cross-tab sync: listen for storage events on the active KB's session key
  useEffect(() => {
    if (!activeKnowledgeBaseId) return;
    const watchKey = sessionKey(activeKnowledgeBaseId);
    const handler = (e: StorageEvent) => {
      if (e.key !== watchKey) return;
      if (!e.newValue) {
        // Token was cleared in another tab
        setSession(null);
        if (proactiveRefreshTimerRef.current) {
          clearTimeout(proactiveRefreshTimerRef.current);
          proactiveRefreshTimerRef.current = null;
        }
        return;
      }
      try {
        const parsed = JSON.parse(e.newValue) as StoredSession;
        if (typeof parsed.access === 'string') {
          // Update our in-memory session token (user info is unchanged)
          setSession(prev => (prev ? { ...prev, token: parsed.access } : prev));
          scheduleProactiveRefresh(parsed.access);
        }
      } catch {
        // Ignore malformed payloads
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [activeKnowledgeBaseId, scheduleProactiveRefresh]);

  // Register module-scoped notify handlers so the QueryCache 401/403 handlers
  // can reach the active provider instance. Returns a cleanup callback that
  // unregisters the handlers when the active KB id changes or the provider
  // unmounts.
  useEffect(() => {
    return registerAuthNotifyHandlers({
      onSessionExpired: (message) => {
        setSessionExpiredMessage(message ?? 'Your session has expired. Please sign in again.');
        setSessionExpiredAt(Date.now());
        setSession(null);
        if (activeKnowledgeBaseId) {
          clearStoredSession(activeKnowledgeBaseId);
        }
        if (proactiveRefreshTimerRef.current) {
          clearTimeout(proactiveRefreshTimerRef.current);
          proactiveRefreshTimerRef.current = null;
        }
      },
      onPermissionDenied: (message) => {
        setPermissionDeniedMessage(message ?? 'You do not have permission to perform this action.');
        setPermissionDeniedAt(Date.now());
      },
    });
  }, [activeKnowledgeBaseId]);

  // Mutations
  const addKnowledgeBase = useCallback((input: NewKnowledgeBase, access: string, refresh: string): KnowledgeBase => {
    const kb: KnowledgeBase = { id: generateKbId(), ...input };
    setStoredSession(kb.id, { access, refresh });
    setKnowledgeBases(prev => [...prev, kb]);
    setActiveKnowledgeBaseId(kb.id);
    return kb;
  }, []);

  const removeKnowledgeBase = useCallback((id: string) => {
    clearStoredSession(id);
    setKnowledgeBases(prev => {
      const remaining = prev.filter(kb => kb.id !== id);
      setActiveKnowledgeBaseId(activeId => activeId === id ? (remaining[0]?.id ?? null) : activeId);
      return remaining;
    });
  }, []);

  const setActiveKnowledgeBase = useCallback((id: string) => {
    setActiveKnowledgeBaseId(id);
  }, []);

  const updateKnowledgeBase = useCallback((id: string, updates: Partial<KnowledgeBase>) => {
    setKnowledgeBases(prev => prev.map(kb => kb.id === id ? { ...kb, ...updates } : kb));
  }, []);

  const signIn = useCallback((id: string, access: string, refresh: string) => {
    setStoredSession(id, { access, refresh });
    // Replace the matching KB with a fresh object so the activeKnowledgeBase
    // memo's `find()` returns a new reference, the validation effect re-runs,
    // and the new tokens get used.
    setKnowledgeBases(prev => prev.map(kb => kb.id === id ? { ...kb } : kb));
    setActiveKnowledgeBaseId(id);
  }, []);

  const signOut = useCallback((id: string) => {
    clearStoredSession(id);
    setActiveKnowledgeBaseId(activeId => {
      if (activeId === id) {
        setSession(null);
        if (proactiveRefreshTimerRef.current) {
          clearTimeout(proactiveRefreshTimerRef.current);
          proactiveRefreshTimerRef.current = null;
        }
      }
      return activeId;
    });
    // Bump the KB list so consumers reading kbStatus(id) see the change
    setKnowledgeBases(prev => [...prev]);
  }, []);

  const acknowledgeSessionExpired = useCallback(() => {
    setSessionExpiredAt(null);
    setSessionExpiredMessage(null);
  }, []);

  const acknowledgePermissionDenied = useCallback(() => {
    setPermissionDeniedAt(null);
    setPermissionDeniedMessage(null);
  }, []);

  // Tick state forces re-derivation of expiresAt-based fields once a minute,
  // so the session-timer UI updates without each consumer running its own interval.
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Derived auth fields
  const value = useMemo<KnowledgeBaseSessionValue>(() => {
    const user = session?.user ?? null;
    const token = session?.token ?? null;
    const expiresAt = token ? parseJwtExpiry(token) : null;

    return {
      knowledgeBases,
      activeKnowledgeBase,
      session,
      isLoading,
      user,
      token,
      isAuthenticated: !!session,
      hasValidBackendToken: !!token,
      isFullyAuthenticated: !!session,
      displayName: user?.name ?? user?.email?.split('@')[0] ?? 'User',
      avatarUrl: user?.image ?? null,
      userDomain: user?.domain || user?.email?.split('@')[1],
      isAdmin: user?.isAdmin ?? false,
      isModerator: user?.isModerator ?? false,
      expiresAt,
      sessionExpiredAt,
      sessionExpiredMessage,
      permissionDeniedAt,
      permissionDeniedMessage,
      addKnowledgeBase,
      removeKnowledgeBase,
      setActiveKnowledgeBase,
      updateKnowledgeBase,
      signIn,
      signOut,
      refreshActive,
      acknowledgeSessionExpired,
      acknowledgePermissionDenied,
    };
  }, [
    knowledgeBases,
    activeKnowledgeBase,
    session,
    isLoading,
    sessionExpiredAt,
    sessionExpiredMessage,
    permissionDeniedAt,
    permissionDeniedMessage,
    addKnowledgeBase,
    removeKnowledgeBase,
    setActiveKnowledgeBase,
    updateKnowledgeBase,
    signIn,
    signOut,
    refreshActive,
    acknowledgeSessionExpired,
    acknowledgePermissionDenied,
  ]);

  return (
    <KnowledgeBaseSessionContext.Provider value={value}>
      {children}
    </KnowledgeBaseSessionContext.Provider>
  );
}

// ---------- Hook ----------

export function useKnowledgeBaseSession(): KnowledgeBaseSessionValue {
  const ctx = useContext(KnowledgeBaseSessionContext);
  if (!ctx) {
    throw new Error(
      'useKnowledgeBaseSession requires KnowledgeBaseSessionProvider. ' +
      'This component is rendered outside the auth boundary. ' +
      'Move it into a protected layout.'
    );
  }
  return ctx;
}
