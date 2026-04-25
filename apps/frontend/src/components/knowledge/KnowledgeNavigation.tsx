import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@/i18n/routing';
import { usePathname, useRouter } from '@/i18n/routing';
import { PlusIcon, ChevronLeftIcon, Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  useSemiont,
  useObservable,
  useEventSubscriptions,
  CollapsibleResourceNavigation,
  type NavigationItem,
} from '@semiont/react-ui';
import type { OpenResource } from '@semiont/sdk';
// Custom telescope icon component
const TelescopeIcon = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: '1.25rem', lineHeight: '1' }}>🔭</span>
);

interface KnowledgeNavigationProps {
  isCollapsed: boolean;
  toggleCollapsed: () => void;
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

// Adapter: CollapsibleResourceNavigation passes href, but our Link uses `to`
function HrefLink({ href, to: _to, ...props }: React.ComponentProps<typeof Link> & { href?: string }) {
  return <Link to={(href ?? '') as string} {...props} />;
}

export function KnowledgeNavigation({ isCollapsed, toggleCollapsed, navigationMenu }: KnowledgeNavigationProps) {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Sidebar.${k}`, p as any) as string;
  const pathname = usePathname();
  const router = useRouter();
  const semiont = useSemiont();
  const openResources = useObservable(semiont.openResources$) ?? [];
  const removeResource = semiont.removeOpenResource.bind(semiont);
  const reorderResources = semiont.reorderOpenResources.bind(semiont);

  const fixedNavigation: NavigationItem[] = [
    {
      name: t('discover'),
      href: '/know/discover',
      icon: TelescopeIcon,
      description: t('searchAndBrowse')
    },
    {
      name: t('compose'),
      href: '/know/compose',
      icon: PlusIcon,
      description: t('composeNewResource')
    }
  ];

  // Handle sidebar toggle events
  const handleSidebarToggle = useCallback(() => {
    toggleCollapsed();
  }, [toggleCollapsed]);

  // Handle resource close events
  const handleResourceClose = useCallback(({ resourceId }: { resourceId: string }) => {
    removeResource(resourceId);

    // If we're closing the currently viewed document, navigate to Discover
    if (pathname === `/know/resource/${resourceId}`) {
      router.push('/know/discover');
    }
  }, [removeResource, pathname, router]);

  // Handle resource reorder events
  const handleResourceReorder = useCallback(({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
    reorderResources(oldIndex, newIndex);
  }, [reorderResources]);

  // Subscribe to navigation events
  useEventSubscriptions({
    'shell:sidebar-toggle': handleSidebarToggle,
    'tabs:close': handleResourceClose,
    'tabs:reorder': handleResourceReorder,
  });

  // Handle navigation
  const handleNavigate = (path: string) => {
    router.push(path);
  };

  // Build resource href
  const getResourceHref = (resourceId: string) => {
    return `/know/resource/${resourceId}`;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <CollapsibleResourceNavigation
          fixedItems={fixedNavigation}
          resources={openResources as OpenResource[]}
          isCollapsed={isCollapsed}
          currentPath={pathname}
          LinkComponent={HrefLink as any}
          onNavigate={handleNavigate}
          getResourceHref={getResourceHref}
          className="knowledge-navigation"
          translations={{
            title: t('title')
          }}
          icons={{
            chevronLeft: ChevronLeftIcon,
            bars: Bars3Icon,
            close: XMarkIcon
          }}
          navigationMenu={navigationMenu}
        />
      </div>
    </div>
  );
}