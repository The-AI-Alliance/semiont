'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname, useRouter } from '@/i18n/routing';
import { PlusIcon, ChevronLeftIcon, Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  useOpenResources,
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
  onToggleCollapse: () => void;
}

export function KnowledgeNavigation({ isCollapsed, onToggleCollapse }: KnowledgeNavigationProps) {
  const t = useTranslations('Knowledge');
  const pathname = usePathname();
  const router = useRouter();
  const { openResources, removeResource, reorderResources } = useOpenResources();

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

  // Handle resource close
  const handleResourceClose = (resourceId: string) => {
    removeResource(resourceId);

    // If we're closing the currently viewed document, navigate to Discover
    if (pathname === `/know/resource/${resourceId}`) {
      router.push('/know/discover');
    }
  };

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
      onToggleCollapse={onToggleCollapse}
      onResourceClose={handleResourceClose}
      onResourceReorder={reorderResources}
      currentPath={pathname}
      LinkComponent={Link as any}
      onNavigate={handleNavigate}
      getResourceHref={getResourceHref}
      className="knowledge-navigation"
      activeClassName="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors"
      inactiveClassName="text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800 group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors"
      translations={{
        title: t('title'),
        collapseSidebar: t('collapseSidebar'),
        expandSidebar: t('expandSidebar'),
        dragToReorder: t('dragToReorder'),
        dragToReorderDoc: t('dragToReorderDoc'),
        closeResource: t('closeResource'),
        dragInstructions: t('dragInstructions')
      }}
      icons={{
        chevronLeft: ChevronLeftIcon,
        bars: Bars3Icon,
        close: XMarkIcon
      }}
    />
  );
}