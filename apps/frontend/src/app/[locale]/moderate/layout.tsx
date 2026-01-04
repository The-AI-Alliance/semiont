'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { LeftSidebar, Footer } from '@semiont/react-ui';
import { ModerationNavigation } from '@/components/moderation/ModerationNavigation';
import { ModerationAuthWrapper } from '@/components/moderation/ModerationAuthWrapper';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';

// Note: Metadata removed from layout to prevent leaking moderation information
// when pages return 404 for security. Metadata should be set in individual
// page components after authentication check.

export default function ModerateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations('Footer');
  const tNav = useTranslations('Navigation');
  const tHome = useTranslations('Home');
  const keyboardContext = useContext(KeyboardShortcutsContext);

  return (
    <ModerationAuthWrapper>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
        <div className="flex flex-1">
          <LeftSidebar Link={Link} routes={routes} t={tNav} tHome={tHome} brandingLink="/">
            <ModerationNavigation />
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
    </ModerationAuthWrapper>
  );
}