import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';

export interface KnowledgeBase {
  id: string;
  label: string;
  backendUrl: string;
}

interface KnowledgeBaseContextValue {
  knowledgeBases: KnowledgeBase[];
  activeKnowledgeBaseId: string | null;
  activeKnowledgeBase: KnowledgeBase | null;
  addKnowledgeBase: (kb: KnowledgeBase) => void;
  removeKnowledgeBase: (id: string) => void;
  setActiveKnowledgeBase: (id: string) => void;
}

const STORAGE_KEY = 'semiont.knowledgeBases';
const ACTIVE_KEY = 'semiont.activeKnowledgeBaseId';

function loadKnowledgeBases(): KnowledgeBase[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as KnowledgeBase[]) : [];
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
    // Use saved id only if it still exists in the list
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
    setKnowledgeBases(prev => {
      const next = prev.filter(kb => kb.id !== id);
      return next;
    });
    setActiveKnowledgeBaseId(prev => {
      if (prev !== id) return prev;
      const remaining = knowledgeBases.filter(kb => kb.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [knowledgeBases]);

  const setActiveKnowledgeBase = useCallback((id: string) => {
    setActiveKnowledgeBaseId(id);
  }, []);

  const activeKnowledgeBase = useMemo(
    () => knowledgeBases.find(kb => kb.id === activeKnowledgeBaseId) ?? null,
    [knowledgeBases, activeKnowledgeBaseId]
  );

  const value = useMemo(
    () => ({ knowledgeBases, activeKnowledgeBaseId, activeKnowledgeBase, addKnowledgeBase, removeKnowledgeBase, setActiveKnowledgeBase }),
    [knowledgeBases, activeKnowledgeBaseId, activeKnowledgeBase, addKnowledgeBase, removeKnowledgeBase, setActiveKnowledgeBase]
  );

  return <KnowledgeBaseContext.Provider value={value}>{children}</KnowledgeBaseContext.Provider>;
}

export function useKnowledgeBaseContext(): KnowledgeBaseContextValue {
  const ctx = useContext(KnowledgeBaseContext);
  if (!ctx) throw new Error('useKnowledgeBaseContext must be used within KnowledgeBaseProvider');
  return ctx;
}
