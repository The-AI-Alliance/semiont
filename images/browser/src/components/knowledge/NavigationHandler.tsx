import { useCallback } from 'react';
import type { EventMap } from '@semiont/core';
import { usePathname, useRouter } from '@/i18n/routing';
import { useEventSubscriptions } from '@semiont/react-ui';
import { routes } from '@/lib/routing';

/**
 * NavigationHandler - Connects NavigationEventBus to Next.js router
 *
 * This component subscribes to navigation events from @semiont/react-ui
 * components and handles them using Next.js client-side routing.
 *
 * Benefits:
 * - Client-side navigation (no page reload)
 * - Preserves React state
 * - Faster navigation
 * - Better UX
 *
 * Must be mounted in app layout to handle all navigation requests.
 *
 * @subscribes beckon:focus - Open the resource a focus names when it names no annotation, from any page. Payload: { resourceId: string, annotationId?: string }
 */
export function NavigationHandler() {
  const router = useRouter();
  const pathname = usePathname();

  // Handle external navigation events
  const handleExternalNavigate = useCallback(({ url, cancelFallback }: { url: string; resourceId?: string; cancelFallback: () => void }) => {
    cancelFallback(); // Prevent window.location fallback since we're handling with client-side routing
    router.push(url);
  }, [router]);

  // Handle router push events
  const handleRouterPush = useCallback(({ path }: { path: string; reason?: string }) => {
    router.push(path);
  }, [router]);

  // A focus on a resource alone brings that resource forward from whatever
  // page is showing: its tab opens, or is selected, and its page mounts at
  // its top. On that resource already, its view scrolls to the top; a focus
  // on an annotation is the views' alone.
  const handleFocus = useCallback(({ annotationId, resourceId }: EventMap['beckon:focus']) => {
    if (annotationId !== undefined) return;
    const path = routes.resourceDetail(resourceId);
    if (path === pathname) return;
    router.push(path);
  }, [router, pathname]);

  useEventSubscriptions({
    'nav:external': handleExternalNavigate,
    'nav:push': handleRouterPush,
    'beckon:focus': handleFocus,
  });

  // This component only manages navigation, doesn't render anything
  return null;
}
