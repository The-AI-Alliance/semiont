import { useEffect, useRef, useMemo } from 'react';
import type { EventMap, ResourceId, ResourceScopedChannel, UnscopedChannel } from '@semiont/core';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from '../hooks/useObservable';

/**
 * Subscribe to a bus event with automatic cleanup.
 *
 * Two buses exist: the app-scoped bus on `SemiontBrowser` (panel, shell,
 * tabs, nav, settings — events that must work without a KB session) and
 * the per-session bus on `SemiontClient` (mark, beckon, gather,
 * match, bind, yield, browse — events tied to a live KB). This hook
 * subscribes to BOTH so components don't need to know which scope a
 * channel is on. Each channel only fires on one bus, so there's no
 * double-delivery.
 *
 * A channel of a resource's scope (`mark:added` and the other events of the
 * record) is not one of these: it is read for one resource, with
 * `useResourceEventSubscriptions`.
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
export function useEventSubscription<K extends UnscopedChannel>(
  eventName: K,
  handler: (payload: EventMap[K]) => void,
): void {
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);

  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    unsubs.push(semiont.on(eventName, (payload) => handlerRef.current(payload)));
    if (session) {
      unsubs.push(session.subscribe(eventName, (payload) => handlerRef.current(payload)));
    }
    return () => { for (const u of unsubs) u(); };
  }, [eventName, semiont, session]);
}

/**
 * Subscribe to multiple bus events at once. Same semantics as
 * `useEventSubscription`, batched — each channel is subscribed on both
 * the app bus (`SemiontBrowser`) and the session bus
 * (`SemiontClient`, when a session is active).
 *
 * @example
 * ```tsx
 * useEventSubscriptions({
 *   'mark:create-ok': ({ annotationId }) => handleCreated(annotationId),
 *   'panel:toggle': ({ panel }) => console.log('toggled', panel),
 * });
 * ```
 */
export function useEventSubscriptions(
  subscriptions: {
    [K in UnscopedChannel]?: (payload: EventMap[K]) => void;
  },
): void {
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);

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
    const unsubs: Array<() => void> = [];
    for (const eventName of eventNames) {
      const channel = eventName as UnscopedChannel;
      const fan = (payload: EventMap[UnscopedChannel]) => {
        const current = handlersRef.current[channel];
        if (current) (current as (p: EventMap[UnscopedChannel]) => void)(payload);
      };
      unsubs.push(semiont.on(channel, fan));
      if (session) {
        unsubs.push(session.subscribe(channel, fan));
      }
    }
    return () => { for (const unsub of unsubs) unsub(); };
  }, [eventNames, semiont, session]);
}

/**
 * Subscribe to the events of one resource: the channels of a resource's
 * scope (`mark:added`, `mark:body-updated` and the other events of the
 * record), on the active session.
 *
 * The subscriptions hold the resource's scope for as long as the component
 * is mounted, and each handler is given that resource's events and no
 * other's. Same stable-handler and stable-key semantics as
 * `useEventSubscriptions`.
 *
 * @example
 * ```tsx
 * useResourceEventSubscriptions(resourceId, {
 *   'mark:added': (stored) => triggerSparkleAnimation(stored.payload.annotation.id),
 * });
 * ```
 */
export function useResourceEventSubscriptions(
  resourceId: ResourceId,
  subscriptions: {
    [K in ResourceScopedChannel]?: (payload: EventMap[K]) => void;
  },
): void {
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);

  const handlersRef = useRef(subscriptions);
  useEffect(() => { handlersRef.current = subscriptions; });

  const eventNames = useMemo(
    () => Object.keys(subscriptions).sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Object.keys(subscriptions).sort().join(',')],
  );

  useEffect(() => {
    if (!session) return;
    const unsubs: Array<() => void> = [];
    for (const eventName of eventNames) {
      const channel = eventName as ResourceScopedChannel;
      const fan = (payload: EventMap[ResourceScopedChannel]) => {
        const current = handlersRef.current[channel];
        if (current) (current as (p: EventMap[ResourceScopedChannel]) => void)(payload);
      };
      unsubs.push(session.subscribe(channel, resourceId, fan));
    }
    return () => { for (const unsub of unsubs) unsub(); };
  }, [eventNames, resourceId, session]);
}
