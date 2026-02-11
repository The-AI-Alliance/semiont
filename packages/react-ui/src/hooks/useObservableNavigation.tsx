'use client';

import { useCallback } from 'react';
import { useNavigationEvents } from '../contexts/NavigationEventBusContext';
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

/**
 * Hook that wraps Next.js router with event emission for observability
 *
 * Use this instead of useRouter() from next/navigation when you want
 * navigation actions to be observable through the NavigationEventBus.
 *
 * @example
 * ```typescript
 * const router = useObservableRouter();
 *
 * // This will emit 'navigation:router-push' event before navigating
 * router.push('/know/discover', { reason: 'resource-closed' });
 * ```
 */
export function useObservableRouter(baseRouter: AppRouterInstance) {
  const eventBus = useNavigationEvents();

  const push = useCallback((path: string, options?: { reason?: string }) => {
    // Emit event for observability
    eventBus.emit('navigation:router-push', {
      path,
      reason: options?.reason
    });

    // Perform actual navigation
    baseRouter.push(path);
  }, [baseRouter, eventBus]);

  const replace = useCallback((path: string, options?: { reason?: string }) => {
    // Emit event for observability
    eventBus.emit('navigation:router-push', {
      path,
      reason: options?.reason ? `replace:${options.reason}` : 'replace'
    });

    // Perform actual navigation
    baseRouter.replace(path);
  }, [baseRouter, eventBus]);

  return {
    ...baseRouter,
    push,
    replace
  };
}

/**
 * Request navigation with event emission
 *
 * This hook emits a navigation request event. The app must subscribe to
 * 'navigation:external-navigate' and perform the actual navigation using
 * its router (Next.js, React Router, etc.) to enable client-side routing.
 *
 * If no subscriber handles the event, falls back to window.location.href
 * after a brief delay to allow for event handling.
 *
 * @example
 * ```typescript
 * // In component (react-ui package)
 * const navigate = useObservableExternalNavigation();
 * navigate('/know/resource/123', { resourceId: '123' });
 *
 * // In app (frontend package) - subscribe and handle with Next.js router
 * const router = useRouter();
 * const eventBus = useNavigationEvents();
 *
 * useEffect(() => {
 *   const handleNav = ({ url }) => {
 *     router.push(url); // Client-side navigation
 *   };
 *   eventBus.on('navigation:external-navigate', handleNav);
 *   return () => eventBus.off('navigation:external-navigate', handleNav);
 * }, [eventBus, router]);
 * ```
 */
export function useObservableExternalNavigation() {
  const eventBus = useNavigationEvents();

  return useCallback((url: string, metadata?: { resourceId?: string }) => {
    // Emit navigation request event
    eventBus.emit('navigation:external-navigate', {
      url,
      resourceId: metadata?.resourceId
    });

    // Fallback: If no subscriber handles navigation within 10ms, use window.location
    // This ensures navigation still works even if app doesn't implement handler
    const fallbackTimer = setTimeout(() => {
      console.warn(
        '[Observable Navigation] No handler for navigation:external-navigate. ' +
        'Falling back to window.location.href. ' +
        'For better UX, subscribe to this event in your app and use client-side routing.'
      );
      window.location.href = url;
    }, 10);

    // Store timer reference so subscribers can cancel fallback
    (eventBus as any)._lastNavigationFallback = fallbackTimer;
  }, [eventBus]);
}
