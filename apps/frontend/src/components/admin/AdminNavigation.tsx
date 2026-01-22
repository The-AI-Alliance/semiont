'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SimpleNavigation } from '@semiont/react-ui';
import type { SimpleNavigationItem } from '@semiont/react-ui';
import {
  UsersIcon,
  ShieldCheckIcon,
  CommandLineIcon,
  ChevronLeftIcon,
  Bars3Icon
} from '@heroicons/react/24/outline';

interface AdminNavigationProps {
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

export function AdminNavigation({ navigationMenu }: AdminNavigationProps = {}) {
  const t = useTranslations('Administration');
  const tSidebar = useTranslations('Sidebar');
  const pathname = usePathname();

  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load collapse state from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('admin-sidebar-collapsed');
    if (stored !== null) {
      setIsCollapsed(stored === 'true');
    }
  }, []);

  // Save collapse state to localStorage
  const handleToggleCollapse = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    localStorage.setItem('admin-sidebar-collapsed', newState.toString());
  };

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
      onToggleCollapse={handleToggleCollapse}
      icons={{
        chevronLeft: ChevronLeftIcon as React.ComponentType<{ className?: string }>,
        bars: Bars3Icon as React.ComponentType<{ className?: string }>
      }}
      collapseSidebarLabel={tSidebar('collapseSidebar')}
      expandSidebarLabel={tSidebar('expandSidebar')}
    />
  );
}