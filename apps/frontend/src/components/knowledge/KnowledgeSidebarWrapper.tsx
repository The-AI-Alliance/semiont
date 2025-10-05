'use client';

import React from 'react';
import { LeftSidebar } from '@/components/shared/LeftSidebar';
import { KnowledgeNavigation } from './KnowledgeNavigation';

export function KnowledgeSidebarWrapper() {
  return (
    <LeftSidebar brandingLink="/" collapsible={true} storageKey="knowledgeNavCollapsed">
      {(isCollapsed, toggleCollapsed) => (
        <KnowledgeNavigation isCollapsed={isCollapsed} onToggleCollapse={toggleCollapsed} />
      )}
    </LeftSidebar>
  );
}
