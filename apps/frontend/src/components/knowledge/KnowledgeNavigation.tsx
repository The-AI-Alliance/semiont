'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname, useRouter } from '@/i18n/routing';
import { PlusIcon, ChevronLeftIcon, Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  useOpenResources,
  useNavigationEvents,
  CollapsibleResourceNavigation,
  type NavigationItem,
  type OpenResource
} from '@semiont/react-ui';

// Custom telescope icon component
const TelescopeIcon = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: '1.25rem', lineHeight: '1' }}>🔭</span>
);

interface KnowledgeNavigationProps {
  isCollapsed: boolean;
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

export function KnowledgeNavigation({ isCollapsed, navigationMenu }: KnowledgeNavigationProps) {
  const t = useTranslations('Sidebar');
  const pathname = usePathname();
  const router = useRouter();
  const { openResources, removeResource, reorderResources } = useOpenResources();
  const eventBus = useNavigationEvents();

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

  // Subscribe to navigation events
  useEffect(() => {
    const handleResourceClose = ({ resourceId }: { resourceId: string }) => {
      removeResource(resourceId);

      // If we're closing the currently viewed document, navigate to Discover
      if (pathname === `/know/resource/${resourceId}`) {
        router.push('/know/discover');
      }
    };

    const handleResourceReorder = ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
      reorderResources(oldIndex, newIndex);
    };

    eventBus.on('navigation:resource-close', handleResourceClose);
    eventBus.on('navigation:resource-reorder', handleResourceReorder);

    return () => {
      eventBus.off('navigation:resource-close', handleResourceClose);
      eventBus.off('navigation:resource-reorder', handleResourceReorder);
    };
  }, [eventBus, removeResource, reorderResources, pathname, router]);

  // Handle navigation
  const handleNavigate = (path: string) => {
    router.push(path);
  };

  // Build resource href
  const getResourceHref = (resourceId: string) => {
    return `/know/resource/${resourceId}`;
  };

  return (
    <CollapsibleResourceNavigation
      fixedItems={fixedNavigation}
      resources={openResources as OpenResource[]}
      isCollapsed={isCollapsed}
      currentPath={pathname}
      LinkComponent={Link as any}
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
  );
}