import { useTranslation } from 'react-i18next';
import { LeftSidebar, useSemiont, useObservable } from '@semiont/react-ui';
import { KnowledgeNavigation } from './KnowledgeNavigation';
import { Link, routes } from '@/lib/routing';

export function KnowledgeSidebarWrapper() {
  const { t } = useTranslation(undefined, { keyPrefix: 'Navigation' });
  const { t: tHome } = useTranslation(undefined, { keyPrefix: 'Home' });
  const session = useObservable(useSemiont().activeSession$);
  const user = useObservable(session?.user$);
  const isAuthenticated = !!user;

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
