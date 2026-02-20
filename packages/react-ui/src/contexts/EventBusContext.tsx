'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { EventBus } from '@semiont/core';

const EventBusContext = createContext<EventBus | null>(null);

/**
 * Global singleton event bus.
 *
 * Uses RxJS-based EventBus from @semiont/core for framework-agnostic event routing.
 *
 * This ensures all components in the application share the same event bus instance,
 * which is critical for cross-component communication (e.g., hovering an annotation
 * in one component scrolls the panel in another component).
 *
 * FUTURE: Multi-Window Support
 * When we need to support multiple document windows (e.g., pop-out resource viewers),
 * we'll need to transition to a per-window event bus architecture:
 *
 * Option 1: Window-scoped event bus
 *   - Create a new event bus for each window/portal
 *   - Pass windowId or documentId to EventBusProvider
 *   - Store Map<windowId, EventBus> instead of single global
 *   - Components use useEventBus(windowId) to get correct bus
 *
 * Option 2: Event bus hierarchy
 *   - Global event bus for app-wide events (settings, navigation)
 *   - Per-document event bus for document-specific events (annotation hover)
 *   - Components subscribe to both buses as needed
 *
 * Option 3: Cross-window event bridge
 *   - Keep per-window buses isolated
 *   - Use BroadcastChannel or postMessage for cross-window events
 *   - Bridge pattern to sync certain events across windows
 *
 * For now, single global bus is correct for single-window app.
 */
let globalEventBus = new EventBus();

/**
 * Reset the global event bus - FOR TESTING ONLY.
 *
 * Call this in test setup (beforeEach) to ensure test isolation.
 * Each test gets a fresh event bus with no lingering subscriptions.
 *
 * @example
 * ```typescript
 * beforeEach(() => {
 *   resetEventBusForTesting();
 * });
 * ```
 */
export function resetEventBusForTesting() {
  globalEventBus.destroy();
  globalEventBus = new EventBus();
}

export interface EventBusProviderProps {
  children: ReactNode;
}

/**
 * Unified event bus provider for all application events
 *
 * Consolidates three previous event buses:
 * - MakeMeaningEventBus (document/annotation operations)
 * - NavigationEventBus (navigation and sidebar UI)
 * - GlobalSettingsEventBus (app-wide settings)
 *
 * Benefits:
 * - Single import: useEventBus()
 * - No decision fatigue about which bus to use
 * - Easier cross-domain coordination
 * - Simpler provider hierarchy
 *
 * NOTE: This provider uses a global singleton event bus to ensure all components
 * share the same instance. Multiple providers in the tree will all reference the
 * same global bus.
 *
 * Operation handlers (API calls triggered by events) are set up separately via
 * the useResolutionFlow hook, which should be called at the resource page level.
 */
export function EventBusProvider({ children }: EventBusProviderProps) {
  const eventBus = useMemo(() => globalEventBus, []);

  return (
    <EventBusContext.Provider value={eventBus}>
      {children}
    </EventBusContext.Provider>
  );
}

/**
 * Hook to access the unified event bus
 *
 * Use this everywhere instead of:
 * - useMakeMeaningEvents()
 * - useNavigationEvents()
 * - useGlobalSettingsEvents()
 *
 * @example
 * ```typescript
 * const eventBus = useEventBus();
 *
 * // Emit any event
 * eventBus.get('annotation:hover').next({ annotationId: '123' });
 * eventBus.get('navigation:sidebar-toggle').next(undefined);
 * eventBus.get('settings:theme-changed').next({ theme: 'dark' });
 *
 * // Subscribe to any event
 * useEffect(() => {
 *   const unsubscribe = eventBus.on('annotation:hover', ({ annotationId }) => {
 *     console.log(annotationId);
 *   });
 *   return () => unsubscribe();
 * }, []);
 * ```
 */
export function useEventBus(): EventBus {
  const eventBus = useContext(EventBusContext);
  if (!eventBus) {
    throw new Error('useEventBus must be used within EventBusProvider');
  }
  return eventBus;
}
