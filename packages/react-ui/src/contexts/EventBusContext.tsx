'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import mitt from 'mitt';
import type { Handler } from 'mitt';
import type { EventMap } from '@semiont/core';

export type EventBus = ReturnType<typeof mitt<EventMap>> & { busId: string };

const EventBusContext = createContext<EventBus | null>(null);

/**
 * Generate an 8-digit hex identifier for an event bus instance
 */
function generateBusId(): string {
  return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
}

/**
 * Create an EventBus instance with logging and unique identifier
 */
function createEventBus(): EventBus {
  const bus = mitt<EventMap>() as EventBus;
  const busId = generateBusId();

  // Add busId property
  bus.busId = busId;

  // Wrap emit to add logging with busId
  const originalEmit = bus.emit.bind(bus);
  bus.emit = <Key extends keyof EventMap>(eventName: Key, payload?: EventMap[Key]) => {
    console.info(`[EventBus:${busId}] emit:`, eventName, payload);
    return originalEmit(eventName, payload as EventMap[Key]);
  };

  // Wrap on to add logging with busId
  const originalOn = bus.on.bind(bus);
  bus.on = <Key extends keyof EventMap>(eventName: Key, handler: Handler<EventMap[Key]>) => {
    console.debug(`[EventBus:${busId}] subscribe:`, eventName);
    return originalOn(eventName, handler);
  };

  // Wrap off to add logging with busId
  const originalOff = bus.off.bind(bus);
  bus.off = <Key extends keyof EventMap>(eventName: Key, handler?: Handler<EventMap[Key]>) => {
    console.debug(`[EventBus:${busId}] unsubscribe:`, eventName);
    return originalOff(eventName, handler);
  };

  return bus;
}

/**
 * Global singleton event bus.
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
let globalEventBus = createEventBus();

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
  globalEventBus = createEventBus();
}

export interface EventBusProviderProps {
  children: ReactNode;
  // rUri and client removed - operation handlers are now set up via useResolutionFlow hook
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
export function EventBusProvider({
  children,
}: EventBusProviderProps) {
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
 * eventBus.emit('annotation:hover', { annotationId: '123' });
 * eventBus.emit('navigation:sidebar-toggle', undefined);
 * eventBus.emit('settings:theme-changed', { theme: 'dark' });
 *
 * // Subscribe to any event
 * useEffect(() => {
 *   const handler = ({ annotationId }) => console.log(annotationId);
 *   eventBus.on('annotation:hover', handler);
 *   return () => eventBus.off('annotation:hover', handler);
 * }, []);
 * ```
 */
export function useEventBus(): EventBus {
  const bus = useContext(EventBusContext);
  if (!bus) {
    throw new Error('useEventBus must be used within EventBusProvider');
  }
  return bus;
}
