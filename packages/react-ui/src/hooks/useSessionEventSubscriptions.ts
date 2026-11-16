'use client';

import { useEffect, useRef, useMemo } from 'react';
import type { EventMap } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

/**
 * Subscribe to session-scoped bus events on an explicit `SemiontSession` — the
 * provider-free counterpart to `useEventSubscriptions`. The embeddable viewer
 * path takes its session as a prop (bring-your-own-session), so it can't reach
 * the app-scoped `SemiontBrowser` bus; every channel it needs (`mark:*`,
 * `browse:click`) is session-scoped anyway and reaches it via `session.subscribe`.
 *
 * Same stable-handler / stable-key semantics as `useEventSubscriptions`:
 * handlers may change every render without re-subscribing; re-subscription
 * happens only when the set of channel names or the session changes. A null
 * session subscribes to nothing, and cleanly re-subscribes when one arrives.
 */
export function useSessionEventSubscriptions(
  session: SemiontSession | null,
  subscriptions: {
    [K in keyof EventMap]?: (payload: EventMap[K]) => void;
  },
): void {
  const handlersRef = useRef(subscriptions);
  useEffect(() => { handlersRef.current = subscriptions; });

  // Stable key derived from the subscribed event names; re-subscribe only when
  // the set changes, not when handlers change.
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
      const fan = (payload: EventMap[keyof EventMap]) => {
        const current = handlersRef.current[channel];
        if (current) (current as (p: EventMap[keyof EventMap]) => void)(payload);
      };
      unsubs.push(session.subscribe(channel, fan));
    }
    return () => { for (const unsub of unsubs) unsub(); };
  }, [eventNames, session]);
}
