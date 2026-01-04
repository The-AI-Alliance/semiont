'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { LeftSidebar } from '@semiont/react-ui';
import { KnowledgeNavigation } from './KnowledgeNavigation';
import { Link, routes } from '@/lib/routing';

export function KnowledgeSidebarWrapper() {
  const t = useTranslations('Navigation');
  const tHome = useTranslations('Home');

  return (
    <LeftSidebar Link={Link} routes={routes} t={t} tHome={tHome} brandingLink="/" collapsible={true} storageKey="knowledgeNavCollapsed">
      {(isCollapsed, toggleCollapsed) => (
        <KnowledgeNavigation isCollapsed={isCollapsed} onToggleCollapse={toggleCollapsed} />
      )}
    </LeftSidebar>
  );
}
