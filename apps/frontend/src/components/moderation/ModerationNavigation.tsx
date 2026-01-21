'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SimpleNavigation } from '@semiont/react-ui';
import type { SimpleNavigationItem } from '@semiont/react-ui';
import {
  ClockIcon,
  TagIcon,
  BookOpenIcon
} from '@heroicons/react/24/outline';

interface ModerationNavigationProps {
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

export function ModerationNavigation({ navigationMenu }: ModerationNavigationProps = {}) {
  const t = useTranslations('Moderation');
  const pathname = usePathname();

  const navigation: SimpleNavigationItem[] = [
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
    <SimpleNavigation
      title={t('title')}
      items={navigation}
      currentPath={pathname}
      LinkComponent={Link as any}
      {...(navigationMenu && { dropdownContent: navigationMenu })}
    />
  );
}