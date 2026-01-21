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
        activeClassName="semiont-nav-link semiont-nav-link--active"
        inactiveClassName="semiont-nav-link"
      />
    </div>
  );
}