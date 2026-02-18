/**
 * usePanelNavigation - Panel navigation and scroll coordination hook
 *
 * Manages sidebar panel state:
 * - Active panel tracking (which panel is open)
 * - Scroll coordination (scrollToAnnotationId)
 * - Panel routing with initial tab
 * - LocalStorage persistence
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useCallback, useEffect } from 'react';
import { useEventSubscriptions } from '../contexts/useEventSubscription';

export type ToolbarPanelType = 'document' | 'history' | 'info' | 'annotations' | 'settings' | 'collaboration' | 'user' | 'jsonld';

export interface PanelNavigationState {
  activePanel: ToolbarPanelType | null;
  scrollToAnnotationId: string | null;
  panelInitialTab: { tab: string; generation: number } | null;
  onScrollCompleted: () => void;
}

/**
 * Hook for panel navigation state management
 *
 * @subscribes panel:toggle - Toggle a panel open/closed
 * @subscribes panel:open - Open a panel, optionally scrolling to an annotation
 * @subscribes panel:close - Close the active panel
 * @returns Panel navigation state
 */
export function usePanelNavigation(): PanelNavigationState {
  // Panel state - load from localStorage, default closed
  const [activePanel, setActivePanel] = useState<ToolbarPanelType | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('activeToolbarPanel');
      return (saved as ToolbarPanelType) || null;
    }
    return null;
  });

  // Scroll coordination state
  const [scrollToAnnotationId, setScrollToAnnotationId] = useState<string | null>(null);
  const [panelInitialTab, setPanelInitialTab] = useState<{ tab: string; generation: number } | null>(null);

  // Persist panel state to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activePanel) {
      localStorage.setItem('activeToolbarPanel', activePanel);
    } else {
      localStorage.removeItem('activeToolbarPanel');
    }
  }, [activePanel]);

  // Handle scroll completion
  const handleScrollCompleted = useCallback(() => {
    setScrollToAnnotationId(null);
  }, []);

  const handlePanelToggle = useCallback(({ panel }: { panel: string }) => {
    setActivePanel((current) => (current === panel ? null : panel as ToolbarPanelType));
  }, []);

  const handlePanelOpen = useCallback(({ panel, scrollToAnnotationId: scrollTarget, motivation }: { panel: string; scrollToAnnotationId?: string; motivation?: string }) => {
    // Store scroll target and motivation for UnifiedAnnotationsPanel
    if (scrollTarget) {
      setScrollToAnnotationId(scrollTarget);
    }

    if (motivation) {
      // Map motivation to tab key
      const motivationToTab: Record<string, string> = {
        'linking': 'reference',
        'commenting': 'comment',
        'tagging': 'tag',
        'highlighting': 'highlight',
        'assessing': 'assessment'
      };

      const tab = motivationToTab[motivation] || 'highlight';
      setPanelInitialTab({ tab, generation: Date.now() });
    }

    setActivePanel(panel as ToolbarPanelType);
  }, []);

  const handlePanelClose = useCallback(() => {
    setActivePanel(null);
  }, []);

  // Subscribe to panel navigation events
  useEventSubscriptions({
    'panel:toggle': handlePanelToggle,
    'panel:open': handlePanelOpen,
    'panel:close': handlePanelClose,
  });

  return {
    activePanel,
    scrollToAnnotationId,
    panelInitialTab,
    onScrollCompleted: handleScrollCompleted,
  };
}
