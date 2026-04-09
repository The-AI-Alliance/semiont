import { useContext } from 'react';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AdminNavigation } from '@/components/admin/AdminNavigation';
import { LeftSidebar, Footer, ApiClientProvider, AuthTokenProvider } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from '@/i18n/routing';
import { useKnowledgeBaseContext, kbBackendUrl } from '@/contexts/KnowledgeBaseContext';
import { AuthShell } from '@/contexts/AuthShell';

function AdminLayoutBody() {
  const { t } = useTranslation();
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const { isAuthenticated, isAdmin, isModerator, token: authToken } = useAuth();
  const { activeKnowledgeBase } = useKnowledgeBaseContext();
  const router = useRouter();

  if (!activeKnowledgeBase) {
    router.push('/know');
    return null;
  }

  return (
    <AuthTokenProvider token={authToken}>
      <ApiClientProvider baseUrl={kbBackendUrl(activeKnowledgeBase)}>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
          <div className="flex flex-1">
            <LeftSidebar
              Link={Link}
              routes={routes}
              t={(key: string) => t(`Navigation.${key}`)}
              tHome={(key: string) => t(`Home.${key}`)}
              brandingLink="/"
              collapsible={true}
              storageKey="admin-sidebar-collapsed"
              isAuthenticated={isAuthenticated}
              isAdmin={isAdmin}
              isModerator={isModerator}
            >
              {(isCollapsed, toggleCollapsed, navigationMenu) => (
                <AdminNavigation
                  isCollapsed={isCollapsed}
                  toggleCollapsed={toggleCollapsed}
                  navigationMenu={navigationMenu}
                />
              )}
            </LeftSidebar>
            <main className="flex-1 p-6 flex flex-col">
              <div className="max-w-7xl mx-auto flex-1 flex flex-col w-full">
                <Outlet />
              </div>
            </main>
          </div>
          <Footer
            Link={Link}
            routes={routes}
            t={(key: string, params?: Record<string, unknown>) => t(`Footer.${key}`, params as any) as string}
            CookiePreferences={CookiePreferences}
            {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
          />
        </div>
      </ApiClientProvider>
    </AuthTokenProvider>
  );
}

export default function AdminLayout() {
  return (
    <AuthShell>
      <AdminLayoutBody />
    </AuthShell>
  );
}
