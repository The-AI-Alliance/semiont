import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@/i18n/routing';
import { usePathname } from '@/i18n/routing';
import { SimpleNavigation, useEventSubscriptions } from '@semiont/react-ui';
import type { SimpleNavigationItem } from '@semiont/react-ui';
import {
  ClockIcon,
  TagIcon,
  BookOpenIcon,
  ArrowsRightLeftIcon,
  ChevronLeftIcon,
  Bars3Icon
} from '@heroicons/react/24/outline';

interface ModerationNavigationProps {
  isCollapsed: boolean;
  toggleCollapsed: () => void;
  navigationMenu?: (onClose: () => void) => React.ReactNode;
}

// Adapter: SimpleNavigation passes href, but our Link uses `to`
function HrefLink({ href, to: _to, ...props }: React.ComponentProps<typeof Link> & { href?: string }) {
  return <Link to={(href ?? '') as string} {...props} />;
}

export function ModerationNavigation({ isCollapsed, toggleCollapsed, navigationMenu }: ModerationNavigationProps) {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Moderation.${k}`, p as any) as string;
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
    },
    {
      name: t('linkedData'),
      href: '/moderate/linked-data',
      icon: ArrowsRightLeftIcon,
      description: t('linkedDataDescription')
    }
  ];

  return (
    <SimpleNavigation
      title={t('title')}
      items={navigation}
      currentPath={pathname}
      LinkComponent={HrefLink as any}
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