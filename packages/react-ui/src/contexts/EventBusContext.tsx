'use client';

import { createContext, useContext, useRef, useEffect, type ReactNode } from 'react';
import { EventBus } from '@semiont/core';
import { createJobReplayBridge } from '@semiont/api-client';

const EventBusContext = createContext<EventBus | null>(null);

export interface EventBusProviderProps {
  children: ReactNode;
}

/**
 * Unified event bus provider for all application events.
 *
 * Each provider mount creates a fresh EventBus instance. This means:
 * - Workspace switches (which remount via key prop) get isolated buses
 * - Tests get isolation naturally — no resetEventBusForTesting needed
 *
 * Operation handlers (API calls triggered by events) are set up separately via
 * the useBindFlow hook, which should be called at the resource page level.
 */
export function EventBusProvider({ children }: EventBusProviderProps) {
  const eventBusRef = useRef<EventBus | null>(null);
  if (!eventBusRef.current) {
    eventBusRef.current = new EventBus();
  }
  const eventBus = eventBusRef.current;

  useEffect(() => {
    const bridge = createJobReplayBridge(eventBus);
    return () => bridge.dispose();
  }, [eventBus]);

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
 * eventBus.get('beckon:hover').next({ annotationId: '123' });
 * eventBus.get('browse:sidebar-toggle').next(undefined);
 * eventBus.get('settings:theme-changed').next({ theme: 'dark' });
 *
 * // Subscribe to any event
 * useEffect(() => {
 *   const unsubscribe = eventBus.on('beckon:hover', ({ annotationId }) => {
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
