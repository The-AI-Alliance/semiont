import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SimpleNavigation, useEventSubscriptions } from '@semiont/react-ui';
import type { SimpleNavigationItem } from '@semiont/react-ui';
import {
  UsersIcon,
  ShieldCheckIcon,
  CommandLineIcon,
  ArrowsRightLeftIcon,
  ChevronLeftIcon,
  Bars3Icon
} from '@heroicons/react/24/outline';

interface AdminNavigationProps {
  isCollapsed: boolean;
  toggleCollapsed: () => void;
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

export function AdminNavigation({ isCollapsed, toggleCollapsed, navigationMenu }: AdminNavigationProps) {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Administration.${k}`, p as any) as string;
  const { t: _tSidebar } = useTranslation();
  const tSidebar = (k: string, p?: Record<string, unknown>) => _tSidebar(`Sidebar.${k}`, p as any) as string;
  const pathname = usePathname();

  // Handle sidebar toggle events
  const handleSidebarToggle = useCallback(() => {
    toggleCollapsed();
  }, [toggleCollapsed]);

  // Subscribe to sidebar toggle events
  useEventSubscriptions({
    'browse:sidebar-toggle': handleSidebarToggle,
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
      name: t('exchange'),
      href: '/admin/exchange',
      icon: ArrowsRightLeftIcon,
      description: t('exchangeDescription')
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