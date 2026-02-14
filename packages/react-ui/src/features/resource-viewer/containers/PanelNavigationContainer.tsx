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
import { useEventBus } from '../../../contexts/EventBusContext';
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
  const eventBus = useEventBus();

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

  // Subscribe to panel navigation events
  useEventSubscriptions({
    'panel:toggle': ({ panel }: { panel: string }) => {
      setActivePanel((current) => {
        const newPanel = current === panel ? null : panel;
        return newPanel;
      });
    },
    'panel:open': ({ panel, scrollToAnnotationId: scrollTarget, motivation }: { panel: string; scrollToAnnotationId?: string; motivation?: string }) => {
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
    },
    'panel:close': () => {
      setActivePanel(null);
    },
  });

  return <>{children({
    activePanel,
    scrollToAnnotationId,
    panelInitialTab,
    onScrollCompleted: handleScrollCompleted,
  })}</>;
}
