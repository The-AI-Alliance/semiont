'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { LeftSidebar } from '@semiont/react-ui';
import { KnowledgeNavigation } from './KnowledgeNavigation';
import { Link, routes } from '@/lib/routing';
import { useAuth } from '@/hooks/useAuth';

export function KnowledgeSidebarWrapper() {
  const t = useTranslations('Navigation');
  const tHome = useTranslations('Home');
  const { isAuthenticated, isAdmin, isModerator } = useAuth();

  return (
    <LeftSidebar
      Link={Link}
      routes={routes}
      t={t}
      tHome={tHome}
      brandingLink="/"
      collapsible={true}
      storageKey="knowledgeNavCollapsed"
      isAuthenticated={isAuthenticated}
      isAdmin={isAdmin}
      isModerator={isModerator}
    >
      {(isCollapsed, toggleCollapsed) => (
        <KnowledgeNavigation isCollapsed={isCollapsed} onToggleCollapse={toggleCollapsed} />
      )}
    </LeftSidebar>
  );
}
