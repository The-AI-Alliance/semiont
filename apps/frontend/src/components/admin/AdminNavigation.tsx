'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SidebarNavigation } from '@semiont/react-ui';
import type { NavigationItem } from '@semiont/react-ui';
import {
  UsersIcon,
  ShieldCheckIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';

export function AdminNavigation() {
  const t = useTranslations('Administration');
  const pathname = usePathname();

  const navigation: NavigationItem[] = [
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
    <div className="p-4">
      <SidebarNavigation
        items={navigation}
        title={t('title')}
        currentPath={pathname}
        LinkComponent={Link as any}
      />
    </div>
  );
}