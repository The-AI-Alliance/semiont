'use client';

import { useCallback } from 'react';
import { useRouter } from '@/i18n/routing';
import { useEventSubscriptions } from '@semiont/react-ui';

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
 */
export function NavigationHandler() {
  const router = useRouter();

  // Handle external navigation events
  const handleExternalNavigate = useCallback(({ url, cancelFallback }: { url: string; resourceId?: string; cancelFallback: () => void }) => {
    cancelFallback(); // Prevent window.location fallback since we're handling with client-side routing
    router.push(url);
  }, [router]);

  // Handle router push events
  const handleRouterPush = useCallback(({ path }: { path: string; reason?: string }) => {
    // This is already using Next.js router in the app layer,
    // but we can still log/track it
    console.debug('[Navigation] Router push requested:', path);
  }, []);

  useEventSubscriptions({
    'navigation:external-navigate': handleExternalNavigate,
    'navigation:router-push': handleRouterPush,
  });

  // This component only manages navigation, doesn't render anything
  return null;
}
