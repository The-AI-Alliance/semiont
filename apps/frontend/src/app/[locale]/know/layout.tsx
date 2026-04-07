import { useContext } from 'react';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import { Footer, ResourceAnnotationsProvider, OpenResourcesProvider, CacheProvider, ApiClientProvider, AuthTokenProvider, useGlobalEvents, useAttentionStream, useStoreTokenSync } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useOpenResourcesManager } from '@/hooks/useOpenResourcesManager';
import { useCacheManager } from '@/hooks/useCacheManager';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from '@/i18n/routing';
import { useKnowledgeBaseContext, kbBackendUrl } from '@/contexts/KnowledgeBaseContext';
import { StreamStatusContext } from '@/contexts/StreamStatusContext';

function GlobalEventsConnector() {
  useStoreTokenSync();
  useGlobalEvents();
  return null;
}

function KnowledgeLayoutInner({ children }: { children: React.ReactNode }) {
  const { status } = useAttentionStream();
  return (
    <StreamStatusContext.Provider value={status}>
      {children}
    </StreamStatusContext.Provider>
  );
}

export default function KnowledgeLayout() {
  const { t } = useTranslation();
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const openResourcesManager = useOpenResourcesManager();
  const cacheManager = useCacheManager();
  const { token: authToken, isLoading } = useAuth();
  const router = useRouter();
  const { activeKnowledgeBase } = useKnowledgeBaseContext();

  if (!activeKnowledgeBase || !authToken) {
    // No KB or not authenticated — render the layout without an API client.
    // The Discover page shows an empty state; the KB panel handles login.
    return (
      <Outlet />
    );
  }

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

  return (
    <AuthTokenProvider token={authToken}>
      <ApiClientProvider baseUrl={kbBackendUrl(activeKnowledgeBase)}>
        <CacheProvider cacheManager={cacheManager}>
          <OpenResourcesProvider openResourcesManager={openResourcesManager}>
            <ResourceAnnotationsProvider>
              <GlobalEventsConnector />
              <KnowledgeLayoutInner>
                <div className="h-screen semiont-knowledge-layout semiont-layout-with-footer flex flex-col overflow-hidden">
                  <div className="flex flex-1 overflow-hidden">
                    <KnowledgeSidebarWrapper />
                    <main className="flex-1 w-full px-2 pb-6 flex flex-col overflow-hidden">
                      <div className="w-full mx-auto flex-1 flex flex-col h-full overflow-hidden">
                        <Outlet />
                      </div>
                    </main>
                  </div>
                  <Footer
                    Link={Link}
                    routes={routes}
                    t={(key: string, params?: Record<string, unknown>) => t(`Footer.${key}`, params as any) as string}
                    CookiePreferences={CookiePreferences}
                    showPolicyLinks={!('__TAURI_INTERNALS__' in window)}
                    {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
                  />
                </div>
              </KnowledgeLayoutInner>
            </ResourceAnnotationsProvider>
          </OpenResourcesProvider>
        </CacheProvider>
      </ApiClientProvider>
    </AuthTokenProvider>
  );
}
