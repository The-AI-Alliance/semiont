'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import { Footer, ResourceAnnotationsProvider, OpenResourcesProvider, CacheProvider, ApiClientProvider, EventBusProvider } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useOpenResourcesManager } from '@/hooks/useOpenResourcesManager';
import { useCacheManager } from '@/hooks/useCacheManager';
import { useApiClientManager } from '@/hooks/useApiClientManager';
import { useRouter } from 'next/navigation';

/**
 * Knowledge Layout
 *
 * Provides feature-specific providers for the /know section:
 * - CacheProvider: Query cache invalidation for resource operations
 * - OpenResourcesProvider: Manage currently open resources (tabs)
 * - ResourceAnnotationsProvider: Annotation CRUD operations and UI state
 */
export default function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations('Footer');
  const router = useRouter();
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const openResourcesManager = useOpenResourcesManager();
  const cacheManager = useCacheManager();

  // Authentication boundary - if useApiClientManager throws, ErrorBoundary will catch it
  // and user will be redirected to sign in
  let apiClientManager;
  try {
    apiClientManager = useApiClientManager();
  } catch (error) {
    // Not authenticated - redirect to home
    router.push('/');
    return null;
  }

  return (
    <ApiClientProvider apiClientManager={apiClientManager}>
      <EventBusProvider>
        <CacheProvider cacheManager={cacheManager}>
          <OpenResourcesProvider openResourcesManager={openResourcesManager}>
            <ResourceAnnotationsProvider>
              <div className="h-screen semiont-knowledge-layout semiont-layout-with-footer flex flex-col overflow-hidden">
                <div className="flex flex-1 overflow-hidden">
                  <KnowledgeSidebarWrapper />
                  <main className="flex-1 w-full px-2 pb-6 flex flex-col overflow-hidden">
                    <div className="w-full mx-auto flex-1 flex flex-col h-full overflow-hidden">
                      {children}
                    </div>
                  </main>
                </div>
                <Footer
                  Link={Link}
                  routes={routes}
                  t={t}
                  CookiePreferences={CookiePreferences}
                  {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
                />
              </div>
            </ResourceAnnotationsProvider>
          </OpenResourcesProvider>
        </CacheProvider>
      </EventBusProvider>
    </ApiClientProvider>
  );
}