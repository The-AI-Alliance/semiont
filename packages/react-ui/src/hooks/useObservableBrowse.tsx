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
 * @emits browse:router-push - Router navigation requested. Payload: { path: string, reason?: string }
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
    eventBus.get('browse:router-push').next({
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
    eventBus.get('browse:router-push').next({
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
 * 'browse:external-navigate' and perform the actual navigation using
 * its router (Next.js, React Router, etc.) to enable client-side routing.
 *
 * If no subscriber handles the event, falls back to window.location.href
 * after a brief delay to allow for event handling.
 *
 * @emits browse:external-navigate - External navigation requested. Payload: { url: string, resourceId?: string, cancelFallback: () => void }
 *
 * The payload includes a `cancelFallback` function that subscribers must call to
 * prevent the window.location fallback from firing. Subscribers that handle the
 * navigation (e.g. via client-side routing) should always call cancelFallback().
 *
 * @example
 * ```typescript
 * // In component (react-ui package)
 * const navigate = useObservableExternalNavigation();
 * navigate('/know/resource/123', { resourceId: '123' });
 *
 * // In app (frontend package) - subscribe, cancel fallback, and handle with Next.js router
 * const router = useRouter();
 * useEventSubscriptions({
 *   'browse:external-navigate': ({ url, cancelFallback }) => {
 *     cancelFallback(); // Prevent window.location fallback
 *     router.push(url); // Client-side navigation
 *   },
 * });
 * ```
 */
export function useObservableExternalNavigation() {
  const eventBus = useEventBus();

  return useCallback((url: string, metadata?: { resourceId?: string }) => {
    // Fallback: If no subscriber cancels within 10ms, use window.location
    // This ensures navigation still works even if app doesn't implement handler
    const fallbackTimer = setTimeout(() => {
      console.warn(
        '[Observable Navigation] No handler cancelled browse:external-navigate fallback. ' +
        'Falling back to window.location.href. ' +
        'For better UX, subscribe to this event in your app, call cancelFallback(), and use client-side routing.'
      );
      window.location.href = url;
    }, 10);

    eventBus.get('browse:external-navigate').next({
      url,
      resourceId: metadata?.resourceId,
      cancelFallback: () => clearTimeout(fallbackTimer),
    });
  }, []); // eventBus is stable
}
