import { useEffect, useRef } from 'react';
import type { EventMap } from './EventBusContext';
import { useEventBus } from './EventBusContext';

/**
 * Subscribe to an event bus event with automatic cleanup.
 *
 * This hook solves the "stale closure" problem by always using the latest
 * version of the handler without re-subscribing.
 *
 * @example
 * ```tsx
 * useEventSubscription('annotation:created', ({ annotation }) => {
 *   // This always uses the latest props/state
 *   triggerSparkleAnimation(annotation.id);
 * });
 * ```
 */
export function useEventSubscription<K extends keyof EventMap>(
  eventName: K,
  handler: (payload: EventMap[K]) => void
): void {
  const eventBus = useEventBus();

  // Store the latest handler in a ref to avoid stale closures
  const handlerRef = useRef(handler);

  // Update ref on every render (no re-subscription needed)
  useEffect(() => {
    handlerRef.current = handler;
  });

  // Subscribe once, using a stable wrapper that calls the current handler
  useEffect(() => {
    const stableHandler = (payload: EventMap[K]) => {
      handlerRef.current(payload);
    };

    eventBus.on(eventName, stableHandler);

    return () => {
      eventBus.off(eventName, stableHandler);
    };
  }, [eventName]); // eventBus is stable, only re-subscribe if event name changes
}

/**
 * Subscribe to multiple events at once.
 *
 * @example
 * ```tsx
 * useEventSubscriptions({
 *   'annotation:created': ({ annotation }) => setNewAnnotation(annotation),
 *   'annotation:deleted': ({ annotationId }) => removeAnnotation(annotationId),
 * });
 * ```
 */
export function useEventSubscriptions(
  subscriptions: {
    [K in keyof EventMap]?: (payload: EventMap[K]) => void;
  }
): void {
  const eventBus = useEventBus();

  // Store the latest handlers in refs
  const handlersRef = useRef(subscriptions);

  // Update refs on every render
  useEffect(() => {
    console.debug('[useEventSubscriptions] Updating handlers ref with:', Object.keys(subscriptions));
    handlersRef.current = subscriptions;
  });

  // Subscribe once per event
  useEffect(() => {
    const stableHandlers = new Map<keyof EventMap, (payload: any) => void>();

    console.debug('[useEventSubscriptions] Setting up subscriptions for events:', Object.keys(subscriptions));

    // Create stable wrappers for each subscription
    for (const [eventName, handler] of Object.entries(subscriptions)) {
      if (!handler) continue;

      const stableHandler = (payload: any) => {
        console.debug('[useEventSubscriptions] Event received:', eventName, 'payload:', payload);
        const currentHandler = handlersRef.current[eventName as keyof EventMap];
        if (currentHandler) {
          console.debug('[useEventSubscriptions] Calling current handler for:', eventName);
          currentHandler(payload);
        } else {
          console.warn('[useEventSubscriptions] No current handler found for:', eventName);
        }
      };

      stableHandlers.set(eventName as keyof EventMap, stableHandler);
      eventBus.on(eventName as keyof EventMap, stableHandler);
      console.debug('[useEventSubscriptions] Subscribed to:', eventName);
    }

    // Cleanup all subscriptions
    return () => {
      console.debug('[useEventSubscriptions] Cleaning up subscriptions for:', Array.from(stableHandlers.keys()));
      for (const [eventName, stableHandler] of stableHandlers) {
        eventBus.off(eventName, stableHandler);
      }
    };
  }, []); // eventBus is stable, subscriptions object changes tracked via handlersRef
}
