/**
 * PanelNavigationContainer - Manages panel navigation and scroll coordination
 *
 * This container isolates panel/sidebar state management:
 * - Active panel state (which sidebar panel is open)
 * - Scroll coordination (scrollToAnnotationId)
 * - Panel initial tab routing
 * - Event subscriptions for panel operations
 *
 * By extracting this container:
 * 1. Panel navigation logic is testable in isolation
 * 2. Separates UI state from presentation
 * 3. Clear event → state flow
 */

import { useState, useCallback, useEffect } from 'react';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';

export interface PanelNavigationState {
  activePanel: string | null;
  scrollToAnnotationId: string | null;
  panelInitialTab: { tab: string; generation: number } | null;
  onScrollCompleted: () => void;
}

export interface PanelNavigationContainerProps {
  children: (state: PanelNavigationState) => React.ReactNode;
}

/**
 * Container for panel navigation state management
 *
 * @subscribes panel:toggle - Toggles panel open/closed. Payload: { panel: string }
 * @subscribes panel:open - Opens panel with optional scroll target and motivation. Payload: { panel: string, scrollToAnnotationId?: string, motivation?: string }
 * @subscribes panel:close - Closes active panel. Payload: none
 *
 * Usage:
 * ```tsx
 * <PanelNavigationContainer>
 *   {({ activePanel, scrollToAnnotationId, onScrollCompleted }) => (
 *     <Sidebar
 *       activePanel={activePanel}
 *       scrollToAnnotationId={scrollToAnnotationId}
 *       onScrollCompleted={onScrollCompleted}
 *     />
 *   )}
 * </PanelNavigationContainer>
 * ```
 */
export function PanelNavigationContainer({
  children,
}: PanelNavigationContainerProps) {

  // Panel state - load from localStorage, default closed
  const [activePanel, setActivePanel] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('activeToolbarPanel');
      return saved || null;
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

  // Event handlers extracted from useEventSubscriptions
  const handlePanelToggle = useCallback(({ panel }: { panel: string }) => {
    setActivePanel((current) => {
      const newPanel = current === panel ? null : panel;
      return newPanel;
    });
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

    setActivePanel(panel);
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

  return <>{children({
    activePanel,
    scrollToAnnotationId,
    panelInitialTab,
    onScrollCompleted: handleScrollCompleted,
  })}</>;
}
