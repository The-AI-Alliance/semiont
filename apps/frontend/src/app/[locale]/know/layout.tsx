import { useContext } from 'react';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import { Footer, ResourceAnnotationsProvider, OpenResourcesProvider, CacheProvider, ApiClientProvider, AuthTokenProvider, useGlobalEvents, useAttentionStream } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useOpenResourcesManager } from '@/hooks/useOpenResourcesManager';
import { useCacheManager } from '@/hooks/useCacheManager';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from '@/i18n/routing';
import { SEMIONT_BACKEND_URL } from '@/lib/env';

function GlobalEventsConnector() {
  useGlobalEvents();
  return null;
}

function AttentionStreamConnector() {
  useAttentionStream();
  return null;
}

export default function KnowledgeLayout() {
  const { t } = useTranslation();
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
      <ApiClientProvider baseUrl={SEMIONT_BACKEND_URL}>
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
                      <Outlet />
                    </div>
                  </main>
                </div>
                <Footer
                  Link={Link}
                  routes={routes}
                  t={(key: string) => t(`Footer.${key}`)}
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
