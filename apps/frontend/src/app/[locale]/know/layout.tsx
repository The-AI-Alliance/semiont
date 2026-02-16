'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { useSession, signIn } from 'next-auth/react';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import { Footer, ResourceAnnotationsProvider, OpenResourcesProvider, CacheProvider, ApiClientProvider, AuthTokenProvider, EventBusProvider } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useOpenResourcesManager } from '@/hooks/useOpenResourcesManager';
import { useCacheManager } from '@/hooks/useCacheManager';
import { useAuthTokenManager } from '@/hooks/useAuthTokenManager';

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
  const { data: session, status } = useSession();

  // IMPORTANT: Must call hooks unconditionally (React Rules of Hooks)
  // Even if not authenticated, we still need to call the hook to keep hook count stable
  const authTokenManager = useAuthTokenManager();

  // Show loading state while checking authentication
  if (status === 'loading') {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Show sign-in prompt if not authenticated
  if (status === 'unauthenticated' || !session?.backendToken) {
    return (
      <div className="h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-shrink-0 w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Authentication Required
            </h2>
          </div>
          <p className="text-gray-600 dark:text-gray-300 mb-6">
            You need to be signed in to access the knowledge base.
          </p>
          <button
            onClick={() => signIn(undefined, { callbackUrl: window.location.pathname })}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <AuthTokenProvider tokenManager={authTokenManager}>
      <ApiClientProvider baseUrl="">
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
    </AuthTokenProvider>
  );
}