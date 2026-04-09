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
 *   - Per-KB JWTs in localStorage
 *   - The "session expired" and "permission denied" flags that drive the modals
 *   - JWT expiry derivations (for the session-timer UI)
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
  useState,
} from 'react';
import { SemiontApiClient, APIError } from '@semiont/api-client';
import { baseUrl, EventBus, accessToken } from '@semiont/core';
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

// ---------- Storage helpers (private) ----------

const TOKEN_PREFIX = 'semiont.token.';
const STORAGE_KEY = 'semiont.knowledgeBases';
const ACTIVE_KEY = 'semiont.activeKnowledgeBaseId';

function getKbTokenFromStorage(kbId: string): string | null {
  return localStorage.getItem(`${TOKEN_PREFIX}${kbId}`);
}

function setKbTokenInStorage(kbId: string, token: string): void {
  localStorage.setItem(`${TOKEN_PREFIX}${kbId}`, token);
}

function clearKbTokenFromStorage(kbId: string): void {
  localStorage.removeItem(`${TOKEN_PREFIX}${kbId}`);
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
  const token = getKbTokenFromStorage(kbId);
  if (!token) return 'signed-out';
  return isJwtExpired(token) ? 'expired' : 'authenticated';
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
 *
 * This is the same pattern React Query itself uses for its global signals.
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
  addKnowledgeBase: (kb: NewKnowledgeBase, token: string) => KnowledgeBase;
  removeKnowledgeBase: (id: string) => void;
  setActiveKnowledgeBase: (id: string) => void;
  updateKnowledgeBase: (id: string, updates: Partial<Pick<KnowledgeBase, 'label'>>) => void;
  /** Re-auth on an existing KB: store the new token and refresh the session. */
  signIn: (id: string, token: string) => void;
  /** Sign out of a KB: clear its stored token. If it's the active KB, clear in-memory session too. */
  signOut: (id: string) => void;

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
    const token = getKbTokenFromStorage(id);
    return !!token && !isJwtExpired(token);
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

  // Validate the active KB's stored token whenever the active KB changes.
  // This is the heart of the merge: KB switching atomically re-validates.
  const activeKnowledgeBase = useMemo(
    () => knowledgeBases.find(kb => kb.id === activeKnowledgeBaseId) ?? null,
    [knowledgeBases, activeKnowledgeBaseId]
  );

  useEffect(() => {
    if (!activeKnowledgeBase) {
      setSession(null);
      setIsLoading(false);
      return;
    }

    const token = getKbTokenFromStorage(activeKnowledgeBase.id);
    if (!token || isJwtExpired(token)) {
      setSession(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    const client = new SemiontApiClient({
      baseUrl: baseUrl(kbBackendUrl(activeKnowledgeBase)),
      eventBus: new EventBus(),
    });
    client.getMe({ auth: accessToken(token) })
      .then((data) => {
        if (cancelled) return;
        setSession({ token, user: data as UserInfo });
      })
      .catch((error) => {
        if (cancelled) return;
        setSession(null);
        if (error instanceof APIError && error.status === 401) {
          clearKbTokenFromStorage(activeKnowledgeBase.id);
          setSessionExpiredMessage('Your session has expired. Please sign in again.');
          setSessionExpiredAt(Date.now());
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeKnowledgeBase]);

  // Register module-scoped notify handlers so the QueryCache 401/403 handlers
  // can reach the active provider instance.
  useEffect(() => {
    activeNotifySessionExpired = (message) => {
      setSessionExpiredMessage(message ?? 'Your session has expired. Please sign in again.');
      setSessionExpiredAt(Date.now());
      setSession(null);
      if (activeKnowledgeBaseId) {
        clearKbTokenFromStorage(activeKnowledgeBaseId);
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
  const addKnowledgeBase = useCallback((input: NewKnowledgeBase, token: string): KnowledgeBase => {
    const kb: KnowledgeBase = { id: generateKbId(), ...input };
    setKbTokenInStorage(kb.id, token);
    setKnowledgeBases(prev => [...prev, kb]);
    setActiveKnowledgeBaseId(kb.id);
    return kb;
  }, []);

  const removeKnowledgeBase = useCallback((id: string) => {
    clearKbTokenFromStorage(id);
    setKnowledgeBases(prev => {
      const remaining = prev.filter(kb => kb.id !== id);
      // If the removed KB was active, reassign or clear
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

  const signIn = useCallback((id: string, token: string) => {
    setKbTokenInStorage(id, token);
    // The validation effect re-runs when `activeKnowledgeBase`'s reference
    // changes. If we sign into the currently-active KB, just bumping the
    // array is not enough — `find()` would return the same KB object and
    // the memo's output reference would be unchanged. Replace the matching
    // KB with a fresh object so `find()` yields a new reference and the
    // validation effect fires.
    setKnowledgeBases(prev => prev.map(kb => kb.id === id ? { ...kb } : kb));
    setActiveKnowledgeBaseId(id);
  }, []);

  const signOut = useCallback((id: string) => {
    clearKbTokenFromStorage(id);
    setActiveKnowledgeBaseId(activeId => {
      if (activeId === id) {
        setSession(null);
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
