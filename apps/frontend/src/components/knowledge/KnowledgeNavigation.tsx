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
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

export function KnowledgeNavigation({ isCollapsed, onToggleCollapse, navigationMenu }: KnowledgeNavigationProps) {
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
      activeClassName="semiont-nav-link semiont-nav-link--active"
      inactiveClassName="semiont-nav-link"
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