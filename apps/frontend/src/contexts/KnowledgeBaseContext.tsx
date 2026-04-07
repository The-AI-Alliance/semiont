import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';

export interface KnowledgeBase {
  id: string;
  label: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  email: string;
}

export function kbBackendUrl(kb: KnowledgeBase): string {
  return `${kb.protocol}://${kb.host}:${kb.port}`;
}

export function defaultProtocol(host: string): 'http' | 'https' {
  return host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https';
}

// Per-KB JWT token storage
const TOKEN_PREFIX = 'semiont.token.';

export function getKbToken(kbId: string): string | null {
  return localStorage.getItem(`${TOKEN_PREFIX}${kbId}`);
}

export function setKbToken(kbId: string, token: string): void {
  localStorage.setItem(`${TOKEN_PREFIX}${kbId}`, token);
}

export function clearKbToken(kbId: string): void {
  localStorage.removeItem(`${TOKEN_PREFIX}${kbId}`);
}

export function isTokenExpired(token: string): boolean {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return true;
    const payload = JSON.parse(atob(payloadPart));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export type KbSessionStatus = 'authenticated' | 'expired' | 'signed-out' | 'unreachable';

export function getKbSessionStatus(kbId: string): KbSessionStatus {
  const token = getKbToken(kbId);
  if (!token) return 'signed-out';
  return isTokenExpired(token) ? 'expired' : 'authenticated';
}

interface KnowledgeBaseContextValue {
  knowledgeBases: KnowledgeBase[];
  activeKnowledgeBaseId: string | null;
  activeKnowledgeBase: KnowledgeBase | null;
  addKnowledgeBase: (kb: KnowledgeBase) => void;
  removeKnowledgeBase: (id: string) => void;
  setActiveKnowledgeBase: (id: string) => void;
  updateKnowledgeBase: (id: string, updates: Partial<Pick<KnowledgeBase, 'label'>>) => void;
  signOut: (id: string) => void;
}

const STORAGE_KEY = 'semiont.knowledgeBases';
const ACTIVE_KEY = 'semiont.activeKnowledgeBaseId';

// Migrate legacy entries that have backendUrl instead of host/port/protocol
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

const KnowledgeBaseContext = createContext<KnowledgeBaseContextValue | undefined>(undefined);

export function KnowledgeBaseProvider({ children }: { children: React.ReactNode }) {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>(() => loadKnowledgeBases());
  const [activeKnowledgeBaseId, setActiveKnowledgeBaseId] = useState<string | null>(() => {
    const saved = localStorage.getItem(ACTIVE_KEY);
    const loaded = loadKnowledgeBases();
    if (saved && loaded.some(kb => kb.id === saved)) return saved;
    return loaded[0]?.id ?? null;
  });

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

  const addKnowledgeBase = useCallback((kb: KnowledgeBase) => {
    setKnowledgeBases(prev => [...prev, kb]);
    setActiveKnowledgeBaseId(kb.id);
  }, []);

  const removeKnowledgeBase = useCallback((id: string) => {
    clearKbToken(id);
    setKnowledgeBases(prev => prev.filter(kb => kb.id !== id));
    setActiveKnowledgeBaseId(prev => {
      if (prev !== id) return prev;
      const remaining = knowledgeBases.filter(kb => kb.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [knowledgeBases]);

  const setActiveKnowledgeBase = useCallback((id: string) => {
    setActiveKnowledgeBaseId(id);
  }, []);

  const updateKnowledgeBase = useCallback((id: string, updates: Partial<Pick<KnowledgeBase, 'label'>>) => {
    setKnowledgeBases(prev => prev.map(kb => kb.id === id ? { ...kb, ...updates } : kb));
  }, []);

  const signOut = useCallback((id: string) => {
    clearKbToken(id);
    // Force re-render by updating the KB list (same entries, new reference)
    setKnowledgeBases(prev => [...prev]);
  }, []);

  const activeKnowledgeBase = useMemo(
    () => knowledgeBases.find(kb => kb.id === activeKnowledgeBaseId) ?? null,
    [knowledgeBases, activeKnowledgeBaseId]
  );

  const value = useMemo(
    () => ({ knowledgeBases, activeKnowledgeBaseId, activeKnowledgeBase, addKnowledgeBase, removeKnowledgeBase, setActiveKnowledgeBase, updateKnowledgeBase, signOut }),
    [knowledgeBases, activeKnowledgeBaseId, activeKnowledgeBase, addKnowledgeBase, removeKnowledgeBase, setActiveKnowledgeBase, updateKnowledgeBase, signOut]
  );

  return <KnowledgeBaseContext.Provider value={value}>{children}</KnowledgeBaseContext.Provider>;
}

export function useKnowledgeBaseContext(): KnowledgeBaseContextValue {
  const ctx = useContext(KnowledgeBaseContext);
  if (!ctx) throw new Error('useKnowledgeBaseContext must be used within KnowledgeBaseProvider');
  return ctx;
}
