import { useContext } from 'react';
import { Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  LeftSidebar,
  Footer,
  useSemiont,
  useObservable,
} from '@semiont/react-ui';
import { ModerationNavigation } from '@/components/moderation/ModerationNavigation';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useRouter } from '@/i18n/routing';

function ModerateLayoutBody() {
  const { t } = useTranslation();
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);
  const user = useObservable(session?.user$);
  const activeKnowledgeBase = session?.kb ?? null;
  const router = useRouter();

  if (!activeKnowledgeBase) {
    router.push('/know');
    return null;
  }

  const isAuthenticated = !!user;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <div className="flex flex-1">
        <LeftSidebar
          Link={Link}
          routes={routes}
          t={(key: string) => t(`Navigation.${key}`)}
          tHome={(key: string) => t(`Home.${key}`)}
          brandingLink="/"
          collapsible={true}
          storageKey="moderation-sidebar-collapsed"
          isAuthenticated={isAuthenticated}
        >
          {(isCollapsed, toggleCollapsed, navigationMenu) => (
            <ModerationNavigation
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
        {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      />
    </div>
  );
}

export default function ModerateLayout() {
  // AuthShell is mounted by the parent ProtectedLayout in App.tsx so it
  // survives navigation between know/, admin/, and moderate/ sections.
  return <ModerateLayoutBody />;
}
