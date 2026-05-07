import React from 'react';
import { useTranslation } from 'react-i18next';
import { LeftSidebar, useSemiont, useObservable } from '@semiont/react-ui';
import { KnowledgeNavigation } from './KnowledgeNavigation';
import { Link, routes } from '@/lib/routing';

export function KnowledgeSidebarWrapper() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Navigation.${k}`, p as any) as string;
  const { t: _tHome } = useTranslation();
  const tHome = (k: string, p?: Record<string, unknown>) => _tHome(`Home.${k}`, p as any) as string;
  const session = useObservable(useSemiont().activeSession$);
  const user = useObservable(session?.user$);
  const isAuthenticated = !!user;
  const isAdmin = user?.isAdmin ?? false;
  const isModerator = user?.isModerator ?? false;

  return (
    <LeftSidebar
      Link={Link}
      routes={routes}
      t={t}
      tHome={tHome}
      brandingLink="/"
      collapsible={true}
      storageKey="knowledgeNavCollapsed"
      isAuthenticated={isAuthenticated}
      isAdmin={isAdmin}
      isModerator={isModerator}
    >
      {(isCollapsed, toggleCollapsed, navigationMenu) => (
        <KnowledgeNavigation
          isCollapsed={isCollapsed}
          toggleCollapsed={toggleCollapsed}
          navigationMenu={navigationMenu}
        />
      )}
    </LeftSidebar>
  );
}
