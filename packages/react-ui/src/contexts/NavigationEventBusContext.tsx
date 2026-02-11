'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import mitt from 'mitt';

/**
 * Navigation event map for UI navigation concerns
 *
 * These events handle navigation-specific UI interactions:
 * - Sidebar collapse/expand state
 * - Resource tab management (close, reorder)
 * - Navigation awareness (for observability and coordination)
 */
export type NavigationEventMap = {
  // Sidebar collapse toggle
  'navigation:sidebar-toggle': void;

  // Resource tab management
  'navigation:resource-close': { resourceId: string };
  'navigation:resource-reorder': { oldIndex: number; newIndex: number };

  // Navigation awareness events (emitted when routing occurs)
  'navigation:link-clicked': { href: string; label?: string };
  'navigation:router-push': { path: string; reason?: string };
  'navigation:external-navigate': { url: string; resourceId?: string };
};

type EventBus = ReturnType<typeof mitt<NavigationEventMap>>;

const NavigationEventBusContext = createContext<EventBus | null>(null);

export interface NavigationEventBusProviderProps {
  children: ReactNode;
}

/**
 * Global event bus provider for navigation UI events
 *
 * Handles UI-level navigation concerns like:
 * - Sidebar collapse/expand
 * - Resource tab close/reorder
 *
 * Available globally - does not require resource context.
 */
export function NavigationEventBusProvider({ children }: NavigationEventBusProviderProps) {
  // Create event bus (one per app)
  const eventBus = useMemo(() => mitt<NavigationEventMap>(), []);

  return (
    <NavigationEventBusContext.Provider value={eventBus}>
      {children}
    </NavigationEventBusContext.Provider>
  );
}

/**
 * Hook to access navigation event bus
 *
 * Use this to emit/subscribe to navigation UI events.
 *
 * @example
 * ```typescript
 * const eventBus = useNavigationEvents();
 *
 * // Emit sidebar toggle
 * eventBus.emit('navigation:sidebar-toggle');
 *
 * // Listen to resource close
 * useEffect(() => {
 *   const handler = ({ resourceId }) => {
 *     console.log('Resource closed:', resourceId);
 *   };
 *   eventBus.on('navigation:resource-close', handler);
 *   return () => eventBus.off('navigation:resource-close', handler);
 * }, [eventBus]);
 * ```
 */
export function useNavigationEvents(): EventBus {
  const bus = useContext(NavigationEventBusContext);
  if (!bus) {
    throw new Error('useNavigationEvents must be used within NavigationEventBusProvider');
  }
  return bus;
}
