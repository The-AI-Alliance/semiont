'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SidebarNavigation } from '@semiont/react-ui';
import type { NavigationItem } from '@semiont/react-ui';
import {
  ClockIcon,
  TagIcon,
  BookOpenIcon
} from '@heroicons/react/24/outline';

export function ModerationNavigation() {
  const t = useTranslations('Moderation');
  const pathname = usePathname();

  const navigation: NavigationItem[] = [
    {
      name: t('recentResources'),
      href: '/moderate/recent',
      icon: ClockIcon,
      description: t('recentResourcesDescription')
    },
    {
      name: t('entityTags'),
      href: '/moderate/entity-tags',
      icon: TagIcon,
      description: t('entityTagsDescription')
    },
    {
      name: t('tagSchemas'),
      href: '/moderate/tag-schemas',
      icon: BookOpenIcon,
      description: t('tagSchemasDescription')
    }
  ];

  return (
    <div className="p-4">
      <SidebarNavigation
        items={navigation}
        title={t('title')}
        currentPath={pathname}
        LinkComponent={Link as any}
        activeClassName="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-r-2 border-blue-500 group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors"
        inactiveClassName="text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800 group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors"
      />
    </div>
  );
}