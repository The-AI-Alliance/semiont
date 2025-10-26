import { useState, useCallback } from 'react';

export type ToolbarPanelType = 'document' | 'history' | 'info' | 'detect' | 'settings' | 'collaboration' | 'user' | 'jsonld';

interface UseToolbarOptions {
  /** Initial panel to show (default: null) */
  initialPanel?: ToolbarPanelType | null;
  /** Whether to persist active panel to localStorage (default: false) */
  persistToStorage?: boolean;
  /** Storage key for persistence (default: 'activeToolbarPanel') */
  storageKey?: string;
}

export function useToolbar(options: UseToolbarOptions = {}) {
  const {
    initialPanel = null,
    persistToStorage = false,
    storageKey = 'activeToolbarPanel'
  } = options;

  // Initialize state from localStorage if persistence is enabled
  const [activePanel, setActivePanel] = useState<ToolbarPanelType | null>(() => {
    if (persistToStorage && typeof window !== 'undefined') {
      const saved = localStorage.getItem(storageKey);
      if (saved && isValidPanel(saved)) {
        // Backwards compatibility: convert old 'stats' to 'info'
        return saved === 'stats' ? 'info' : (saved as ToolbarPanelType);
      }
    }
    return initialPanel;
  });

  const togglePanel = useCallback((panel: ToolbarPanelType) => {
    setActivePanel(current => {
      const newPanel = current === panel ? null : panel;

      // Persist to localStorage if enabled
      if (persistToStorage && typeof window !== 'undefined') {
        if (newPanel) {
          localStorage.setItem(storageKey, newPanel);
        } else {
          localStorage.removeItem(storageKey);
        }
      }

      return newPanel;
    });
  }, [persistToStorage, storageKey]);

  return {
    activePanel,
    togglePanel,
    setActivePanel
  };
}

// Helper to validate panel names
function isValidPanel(value: string): boolean {
  return ['document', 'history', 'info', 'detect', 'settings', 'collaboration', 'user', 'jsonld', 'stats'].includes(value);
}
