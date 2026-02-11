'use client';

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

  useEventSubscriptions({
    'navigation:external-navigate': ({ url }: { url: string; resourceId?: string }) => {
      // Perform client-side navigation with Next.js router
      router.push(url);
    },
    'navigation:router-push': ({ path }: { path: string; reason?: string }) => {
      // This is already using Next.js router in the app layer,
      // but we can still log/track it
      console.debug('[Navigation] Router push requested:', path);
    }
  });

  // This component only manages navigation, doesn't render anything
  return null;
}
