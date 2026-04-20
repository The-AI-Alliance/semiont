import { useEffect, useRef, useMemo } from 'react';
import type { EventMap } from '@semiont/core';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from '../hooks/useObservable';

/**
 * Subscribe to a session-bus event with automatic cleanup.
 *
 * Routes through `session.on(channel, handler)` — components never touch
 * the bus directly (D7). If no session is active, the subscription is a
 * no-op; when a session becomes active, the effect re-runs and binds.
 *
 * Stable-handler pattern: the ref-wrapped handler means `handler` itself
 * can change on every render without causing a re-subscription.
 *
 * @example
 * ```tsx
 * useEventSubscription('mark:create-ok', ({ annotationId }) => {
 *   triggerSparkleAnimation(annotationId);
 * });
 * ```
 */
export function useEventSubscription<K extends keyof EventMap>(
  eventName: K,
  handler: (payload: EventMap[K]) => void,
): void {
  const session = useObservable(useSemiont().activeSession$);

  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });

  useEffect(() => {
    if (!session) return;
    return session.on(eventName, (payload) => handlerRef.current(payload));
  }, [eventName, session]);
}

/**
 * Subscribe to multiple session-bus events at once. Same semantics as
 * `useEventSubscription`, batched. No component ever sees the bus.
 *
 * @example
 * ```tsx
 * useEventSubscriptions({
 *   'mark:create-ok': ({ annotationId }) => handleCreated(annotationId),
 *   'mark:delete-ok': ({ annotationId }) => removeAnnotation(annotationId),
 * });
 * ```
 */
export function useEventSubscriptions(
  subscriptions: {
    [K in keyof EventMap]?: (payload: EventMap[K]) => void;
  },
): void {
  const session = useObservable(useSemiont().activeSession$);

  const handlersRef = useRef(subscriptions);
  useEffect(() => { handlersRef.current = subscriptions; });

  // Stable key derived from the subscribed event names; re-subscribe
  // only when the set changes, not when handlers change.
  const eventNames = useMemo(
    () => Object.keys(subscriptions).sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Object.keys(subscriptions).sort().join(',')],
  );

  useEffect(() => {
    if (!session) return;
    const unsubs: Array<() => void> = [];
    for (const eventName of eventNames) {
      const channel = eventName as keyof EventMap;
      unsubs.push(
        session.on(channel, (payload) => {
          const current = handlersRef.current[channel];
          if (current) (current as (p: EventMap[keyof EventMap]) => void)(payload);
        }),
      );
    }
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [eventNames, session]);
}
