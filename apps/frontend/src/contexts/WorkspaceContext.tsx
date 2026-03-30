import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';

export interface Workspace {
  id: string;
  label: string;
  backendUrl: string;
}

interface WorkspaceContextValue {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeWorkspace: Workspace | null;
  addWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
}

const STORAGE_KEY = 'semiont.workspaces';
const ACTIVE_KEY = 'semiont.activeWorkspaceId';

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Workspace[]) : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(workspaces: Workspace[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => loadWorkspaces());
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() => {
    const saved = localStorage.getItem(ACTIVE_KEY);
    const loaded = loadWorkspaces();
    // Use saved id only if it still exists in the list
    if (saved && loaded.some(w => w.id === saved)) return saved;
    return loaded[0]?.id ?? null;
  });

  useEffect(() => {
    saveWorkspaces(workspaces);
  }, [workspaces]);

  useEffect(() => {
    if (activeWorkspaceId) {
      localStorage.setItem(ACTIVE_KEY, activeWorkspaceId);
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }, [activeWorkspaceId]);

  const addWorkspace = useCallback((workspace: Workspace) => {
    setWorkspaces(prev => {
      const next = [...prev, workspace];
      return next;
    });
    setActiveWorkspaceId(workspace.id);
  }, []);

  const removeWorkspace = useCallback((id: string) => {
    setWorkspaces(prev => {
      const next = prev.filter(w => w.id !== id);
      return next;
    });
    setActiveWorkspaceId(prev => {
      if (prev !== id) return prev;
      const remaining = workspaces.filter(w => w.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [workspaces]);

  const setActiveWorkspace = useCallback((id: string) => {
    setActiveWorkspaceId(id);
  }, []);

  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId]
  );

  const value = useMemo(
    () => ({ workspaces, activeWorkspaceId, activeWorkspace, addWorkspace, removeWorkspace, setActiveWorkspace }),
    [workspaces, activeWorkspaceId, activeWorkspace, addWorkspace, removeWorkspace, setActiveWorkspace]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspaceContext must be used within WorkspaceProvider');
  return ctx;
}
