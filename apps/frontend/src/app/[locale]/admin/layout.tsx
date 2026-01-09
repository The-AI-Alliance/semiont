'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { AdminNavigation } from '@/components/admin/AdminNavigation';
import { LeftSidebar, Footer } from '@semiont/react-ui';
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

  // Middleware has already verified admin access
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <div className="flex flex-1">
        <LeftSidebar
          Link={Link}
          routes={routes}
          t={tNav}
          tHome={tHome}
          brandingLink="/"
          isAuthenticated={isAuthenticated}
          isAdmin={isAdmin}
          isModerator={isModerator}
        >
          <AdminNavigation />
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
  );
}