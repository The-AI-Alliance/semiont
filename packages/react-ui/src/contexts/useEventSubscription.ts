import { useEffect, useRef, useMemo } from 'react';
import type { EventMap } from '@semiont/core';
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

    // RxJS EventBus.get() returns Subject, subscribe returns Subscription
    const subscription = eventBus.get(eventName).subscribe(stableHandler);

    return () => {
      subscription.unsubscribe();
    };
  }, [eventName, eventBus]); // eventBus is stable, only re-subscribe if event name changes
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
    handlersRef.current = subscriptions;
  });

  // Get stable list of event names to subscribe to
  const eventNames = useMemo(
    () => Object.keys(subscriptions).sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Object.keys(subscriptions).sort().join(',')]
  );

  // Subscribe once per event - only re-subscribe if event names actually change
  useEffect(() => {
    const subscriptions: Array<{ unsubscribe: () => void }> = [];

    // Create stable wrappers for each subscription
    for (const eventName of eventNames) {
      const stableHandler = (payload: any) => {
        const currentHandler = handlersRef.current[eventName as keyof EventMap];
        if (currentHandler) {
          currentHandler(payload);
        } else {
          console.warn('[useEventSubscriptions] No current handler found for:', eventName);
        }
      };

      // RxJS EventBus.get() returns Subject, subscribe returns Subscription
      const subscription = eventBus.get(eventName as keyof EventMap).subscribe(stableHandler);
      subscriptions.push(subscription);
    }

    // Cleanup: unsubscribe from all subscriptions
    return () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    };
  }, [eventNames, eventBus]); // eventBus is stable singleton - never in deps; only re-subscribe if event names change
}
