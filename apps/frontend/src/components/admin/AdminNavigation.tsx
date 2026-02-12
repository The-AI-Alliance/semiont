'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SimpleNavigation, useEventSubscriptions } from '@semiont/react-ui';
import type { SimpleNavigationItem } from '@semiont/react-ui';
import {
  UsersIcon,
  ShieldCheckIcon,
  CommandLineIcon,
  ChevronLeftIcon,
  Bars3Icon
} from '@heroicons/react/24/outline';

interface AdminNavigationProps {
  isCollapsed: boolean;
  toggleCollapsed: () => void;
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

export function AdminNavigation({ isCollapsed, toggleCollapsed, navigationMenu }: AdminNavigationProps) {
  const t = useTranslations('Administration');
  const tSidebar = useTranslations('Sidebar');
  const pathname = usePathname();

  // Subscribe to sidebar toggle events
  useEventSubscriptions({
    'navigation:sidebar-toggle': () => {
      toggleCollapsed();
    }
  });

  const navigation: SimpleNavigationItem[] = [
    {
      name: t('users'),
      href: '/admin/users',
      icon: UsersIcon,
      description: t('usersDescription')
    },
    {
      name: t('oauthSettings'),
      href: '/admin/security',
      icon: ShieldCheckIcon,
      description: t('oauthSettingsDescription')
    },
    {
      name: t('devops'),
      href: '/admin/devops',
      icon: CommandLineIcon,
      description: t('devopsDescription')
    },
  ];

  return (
    <SimpleNavigation
      title={t('title')}
      items={navigation}
      currentPath={pathname}
      LinkComponent={Link as any}
      {...(navigationMenu && { dropdownContent: navigationMenu })}
      isCollapsed={isCollapsed}
      icons={{
        chevronLeft: ChevronLeftIcon as React.ComponentType<{ className?: string }>,
        bars: Bars3Icon as React.ComponentType<{ className?: string }>
      }}
      collapseSidebarLabel={tSidebar('collapseSidebar')}
      expandSidebarLabel={tSidebar('expandSidebar')}
    />
  );
}