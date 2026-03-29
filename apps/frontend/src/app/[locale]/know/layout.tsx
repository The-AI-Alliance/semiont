'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import { Footer, ResourceAnnotationsProvider, OpenResourcesProvider, CacheProvider, ApiClientProvider, AuthTokenProvider, useGlobalEvents, useAttentionStream } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useOpenResourcesManager } from '@/hooks/useOpenResourcesManager';
import { useCacheManager } from '@/hooks/useCacheManager';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from '@/i18n/routing';
import { NEXT_PUBLIC_BACKEND_URL } from '@/lib/env';

/** Connects to global SSE stream for system-level events (entity type changes, etc.) */
function GlobalEventsConnector() {
  useGlobalEvents();
  return null;
}

/** Connects to participant-scoped attention stream for cross-participant beckon signals */
function AttentionStreamConnector() {
  useAttentionStream();
  return null;
}

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
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const openResourcesManager = useOpenResourcesManager();
  const cacheManager = useCacheManager();
  const { token: authToken, isLoading } = useAuth();
  const router = useRouter();

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!authToken) {
    router.push(`/auth/signin?callbackUrl=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/know')}`);
    return null;
  }

  return (
    <AuthTokenProvider token={authToken}>
      <ApiClientProvider baseUrl={NEXT_PUBLIC_BACKEND_URL}>
        <CacheProvider cacheManager={cacheManager}>
            <OpenResourcesProvider openResourcesManager={openResourcesManager}>
              <ResourceAnnotationsProvider>
                <GlobalEventsConnector />
                <AttentionStreamConnector />
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
      </ApiClientProvider>
    </AuthTokenProvider>
  );
}