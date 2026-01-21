'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SimpleNavigation } from '@semiont/react-ui';
import type { SimpleNavigationItem } from '@semiont/react-ui';
import {
  UsersIcon,
  ShieldCheckIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';

interface AdminNavigationProps {
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

export function AdminNavigation({ navigationMenu }: AdminNavigationProps = {}) {
  const t = useTranslations('Administration');
  const pathname = usePathname();

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
    />
  );
}