'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import { Footer, ResourceAnnotationsProvider, OpenResourcesProvider } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useOpenResourcesManager } from '@/hooks/useOpenResourcesManager';

export default function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations('Footer');
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const openResourcesManager = useOpenResourcesManager();

  return (
    <OpenResourcesProvider openResourcesManager={openResourcesManager}>
      <ResourceAnnotationsProvider>
        <div className="h-screen bg-gray-50 dark:bg-gray-900 flex flex-col overflow-hidden">
          <div className="flex flex-1 overflow-hidden">
            <KnowledgeSidebarWrapper />
            <main className="flex-1 px-2 pb-6 flex flex-col overflow-hidden">
              <div className="max-w-7xl mx-auto flex-1 flex flex-col w-full h-full overflow-hidden">
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
  );
}