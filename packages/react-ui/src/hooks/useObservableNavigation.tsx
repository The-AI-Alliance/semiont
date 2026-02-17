'use client';

import { useCallback } from 'react';
import { useEventBus } from '../contexts/EventBusContext';

/**
 * Generic router interface - works with any router that has push/replace methods
 * (Next.js App Router, Next.js Pages Router, React Router, etc.)
 */
interface Router {
  push: (path: string) => void;
  replace?: (path: string) => void;
  [key: string]: any;
}

/**
 * Hook that wraps any router with event emission for observability
 *
 * Use this to wrap your router (Next.js, React Router, etc.) when you want
 * navigation actions to be observable through the NavigationEventBus.
 *
 * @emits navigation:router-push - Router navigation requested. Payload: { path: string, reason?: string }
 *
 * @example
 * ```typescript
 * // Next.js App Router
 * import { useRouter } from 'next/navigation';
 * const nextRouter = useRouter();
 * const router = useObservableRouter(nextRouter);
 * router.push('/know/discover', { reason: 'resource-closed' });
 *
 * // React Router
 * import { useNavigate } from 'react-router-dom';
 * const navigate = useNavigate();
 * const router = useObservableRouter({ push: navigate });
 * router.push('/know/discover', { reason: 'resource-closed' });
 * ```
 */
export function useObservableRouter<T extends Router>(baseRouter: T): T {
  const eventBus = useEventBus();

  const push = useCallback((path: string, options?: { reason?: string }) => {
    // Emit event for observability
    eventBus.emit('navigation:router-push', {
      path,
      reason: options?.reason
    });

    // Perform actual navigation
    baseRouter.push(path);
  }, []); // baseRouter and eventBus are both stable

  const replace = useCallback((path: string, options?: { reason?: string }) => {
    // Only wrap replace if the router has it
    if (!baseRouter.replace) return;

    // Emit event for observability
    eventBus.emit('navigation:router-push', {
      path,
      reason: options?.reason ? `replace:${options.reason}` : 'replace'
    });

    // Perform actual navigation
    baseRouter.replace(path);
  }, []); // baseRouter and eventBus are both stable

  return {
    ...baseRouter,
    push,
    ...(baseRouter.replace && { replace })
  } as T;
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
 * @emits navigation:external-navigate - External navigation requested. Payload: { url: string, context?: Record<string, unknown> }
 *
 * @example
 * ```typescript
 * // In component (react-ui package)
 * const navigate = useObservableExternalNavigation();
 * navigate('/know/resource/123', { resourceId: '123' });
 *
 * // In app (frontend package) - subscribe and handle with Next.js router
 * const router = useRouter();
 * const eventBus = useEventBus();
 *
 * useEffect(() => {
 *   const handleNav = ({ url }) => {
 *     router.push(url); // Client-side navigation
 *   };
 *   eventBus.on('navigation:external-navigate', handleNav);
 *   return () => eventBus.off('navigation:external-navigate', handleNav);
 * }, []);
 * ```
 */
export function useObservableExternalNavigation() {
  const eventBus = useEventBus();

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
  }, []); // eventBus is stable
}
