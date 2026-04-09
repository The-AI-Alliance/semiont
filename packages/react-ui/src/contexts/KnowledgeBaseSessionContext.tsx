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
 * atomically. The previous split forced consumers to coordinate two
 * contexts and helper functions across module boundaries.
 *
 * What it owns:
 *   - The list of configured KBs (persisted to localStorage)
 *   - Which KB is currently active (persisted to localStorage)
 *   - The validated session (token + user) for the active KB
 *   - Per-KB sessions (`{ access, refresh }`) in localStorage
 *   - The "session expired" and "permission denied" flags that drive the modals
 *   - JWT expiry derivations (for the session-timer UI)
 *   - Refresh-token logic with concurrency control (one in-flight refresh per KB)
 *   - Proactive refresh: a timer that fires before the access token expires
 *   - Cross-tab sync: when another tab refreshes or signs out, this tab updates
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
import { baseUrl, EventBus, accessToken, refreshToken as makeRefreshToken } from '@semiont/core';
import type { components } from '@semiont/core';
import type {
  KnowledgeBase,
  KbSessionStatus,
  NewKnowledgeBase,
} from '../types/knowledge-base';

type UserInfo = components['schemas']['UserResponse'];

export interface AuthSession {
  token: string;
  user: UserInfo;
}

/** The shape persisted to localStorage per KB. */
export interface StoredSession {
  access: string;
  refresh: string;
}

// ---------- Storage helpers (private) ----------

const SESSION_PREFIX = 'semiont.session.';
const STORAGE_KEY = 'semiont.knowledgeBases';
const ACTIVE_KEY = 'semiont.activeKnowledgeBaseId';

/** Refresh the access token this many milliseconds before it expires. */
const REFRESH_BEFORE_EXP_MS = 5 * 60 * 1000;

function sessionKey(kbId: string): string {
  return `${SESSION_PREFIX}${kbId}`;
}

function getStoredSession(kbId: string): StoredSession | null {
  const raw = localStorage.getItem(sessionKey(kbId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.access === 'string' && typeof parsed.refresh === 'string') {
      return { access: parsed.access, refresh: parsed.refresh };
    }
  } catch {
    // malformed entry — treat as no session
  }
  return null;
}

function setStoredSession(kbId: string, session: StoredSession): void {
  localStorage.setItem(sessionKey(kbId), JSON.stringify(session));
}

function clearStoredSession(kbId: string): void {
  localStorage.removeItem(sessionKey(kbId));
}

function parseJwtExpiry(token: string): Date | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(atob(parts[1])) as { exp?: number };
    if (!payload.exp) return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

function isJwtExpired(token: string): boolean {
  const expiry = parseJwtExpiry(token);
  if (!expiry) return true;
  return expiry.getTime() < Date.now();
}

function migrateLegacyEntry(entry: any): KnowledgeBase {
  if (entry.host !== undefined) return entry as KnowledgeBase;
  // Legacy format: { id, label, backendUrl }
  try {
    const url = new URL(entry.backendUrl);
    return {
      id: entry.id,
      label: entry.label,
      host: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
      email: '',
    };
  } catch {
    return {
      id: entry.id,
      label: entry.label || 'Unknown',
      host: 'localhost',
      port: 4000,
      protocol: 'http',
      email: '',
    };
  }
}

function loadKnowledgeBases(): KnowledgeBase[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const entries = JSON.parse(raw) as any[];
    return entries.map(migrateLegacyEntry);
  } catch {
    return [];
  }
}

function saveKnowledgeBases(knowledgeBases: KnowledgeBase[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(knowledgeBases));
}

// ---------- Public pure helpers ----------

export function defaultProtocol(host: string): 'http' | 'https' {
  return host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https';
}

export function kbBackendUrl(kb: KnowledgeBase): string {
  return `${kb.protocol}://${kb.host}:${kb.port}`;
}

/**
 * Read the locally-stored credential status for a KB. Pure / synchronous —
 * does not subscribe to context changes. Used by KB-list UI to color status
 * dots without requiring re-renders on every tick.
 */
export function getKbSessionStatus(kbId: string): KbSessionStatus {
  const stored = getStoredSession(kbId);
  if (!stored) return 'signed-out';
  return isJwtExpired(stored.access) ? 'expired' : 'authenticated';
}

// ---------- Refresh-token coordination (module-scoped) ----------

/**
 * One in-flight refresh promise per KB. Ensures concurrent 401s for the same
 * KB deduplicate to a single network call.
 */
const inFlightRefreshes: Map<string, Promise<string | null>> = new Map();

async function performRefresh(kb: KnowledgeBase): Promise<string | null> {
  const existing = inFlightRefreshes.get(kb.id);
  if (existing) return existing;

  const promise = (async (): Promise<string | null> => {
    const stored = getStoredSession(kb.id);
    if (!stored) return null;

    const client = new SemiontApiClient({
      baseUrl: baseUrl(kbBackendUrl(kb)),
      eventBus: new EventBus(),
    });

    try {
      const response = await client.refreshToken(makeRefreshToken(stored.refresh));
      const newAccess = response.access_token;
      if (!newAccess) return null;
      setStoredSession(kb.id, { access: newAccess, refresh: stored.refresh });
      return newAccess;
    } catch {
      return null;
    }
  })();

  inFlightRefreshes.set(kb.id, promise);
  try {
    return await promise;
  } finally {
    inFlightRefreshes.delete(kb.id);
  }
}

// ---------- Module-scoped session-expired notifier ----------

/**
 * The provider registers itself with this module-scoped slot on mount and
 * unregisters on unmount. Code outside the React tree (notably the React
 * Query QueryCache.onError handler in app providers) calls these functions
 * to notify the active provider that the session has expired or that a
 * permission was denied.
 *
 * When no provider is mounted (e.g. on the landing page), these calls are
 * no-ops — there is nothing to notify.
 */
type Notify = (message?: string) => void;

let activeNotifySessionExpired: Notify | null = null;
let activeNotifyPermissionDenied: Notify | null = null;

export function notifySessionExpired(message?: string): void {
  activeNotifySessionExpired?.(message);
}

export function notifyPermissionDenied(message?: string): void {
  activeNotifyPermissionDenied?.(message);
}

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
  updateKnowledgeBase: (id: string, updates: Partial<Pick<KnowledgeBase, 'label'>>) => void;
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

function generateKbId(): string {
  return crypto.randomUUID();
}

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

  // Validate the active KB's stored token whenever the active KB changes.
  // If the access token is past its exp, refresh first.
  // If getMe returns 401, try one refresh and revalidate.
  // If refresh fails or returns 401, surface the session-expired modal.
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
  // can reach the active provider instance.
  useEffect(() => {
    activeNotifySessionExpired = (message) => {
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
    };
    activeNotifyPermissionDenied = (message) => {
      setPermissionDeniedMessage(message ?? 'You do not have permission to perform this action.');
      setPermissionDeniedAt(Date.now());
    };
    return () => {
      activeNotifySessionExpired = null;
      activeNotifyPermissionDenied = null;
    };
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

  const updateKnowledgeBase = useCallback((id: string, updates: Partial<Pick<KnowledgeBase, 'label'>>) => {
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
