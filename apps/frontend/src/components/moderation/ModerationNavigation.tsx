'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import {
  ClockIcon,
  TagIcon,
  FlagIcon,
  ChartBarIcon,
  BookOpenIcon
} from '@heroicons/react/24/outline';

export function ModerationNavigation() {
  const t = useTranslations('Moderation');
  const pathname = usePathname();

  const navigation = [
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
    // Future navigation items can be added here
    // {
    //   name: 'Content Review',
    //   href: '/moderate/review',
    //   icon: FlagIcon,
    //   description: 'Review flagged content'
    // },
    // {
    //   name: 'Analytics',
    //   href: '/moderate/analytics',
    //   icon: ChartBarIcon,
    //   description: 'Tag usage and content statistics'
    // }
  ];

  return (
    <div className="p-4">
      <div className="space-y-1">
        <div>
          <div className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            {t('title')}
          </div>

          {navigation.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-r-2 border-blue-500'
                    : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
                title={item.description}
              >
                <item.icon
                  className={`flex-shrink-0 -ml-1 mr-3 h-5 w-5 ${
                    isActive
                      ? 'text-blue-500 dark:text-blue-400'
                      : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
                  }`}
                />
                {item.name}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}