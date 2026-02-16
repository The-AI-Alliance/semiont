'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { AdminNavigation } from '@/components/admin/AdminNavigation';
import { LeftSidebar, Footer, EventBusProvider, ApiClientProvider, AuthTokenProvider } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useAuth } from '@/hooks/useAuth';

// Note: Authentication is handled by middleware.ts for all admin routes
// This ensures centralized security and returns 404 for unauthorized users

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations('Footer');
  const tNav = useTranslations('Navigation');
  const tHome = useTranslations('Home');
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const { isAuthenticated, isAdmin, isModerator } = useAuth();
  const { data: session } = useSession();

  // Extract auth token from session
  const authToken = session?.backendToken || null;

  // Middleware has already verified admin access
  return (
    <AuthTokenProvider token={authToken}>
      <ApiClientProvider baseUrl="">
        <EventBusProvider>
          <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
            <div className="flex flex-1">
              <LeftSidebar
                Link={Link}
                routes={routes}
                t={tNav}
                tHome={tHome}
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
        </EventBusProvider>
      </ApiClientProvider>
    </AuthTokenProvider>
  );
}
