'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { PlusIcon, ChevronLeftIcon, Bars3Icon } from '@heroicons/react/24/outline';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { SortableDocumentTab } from './SortableDocumentTab';

// Custom telescope icon component
const TelescopeIcon = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: '1.25rem', lineHeight: '1' }}>🔭</span>
);

const fixedNavigation = [
  {
    name: 'Discover',
    href: '/know/discover',
    icon: TelescopeIcon,
    description: 'Search and browse documents'
  },
  {
    name: 'Compose',
    href: '/know/compose',
    icon: PlusIcon,
    description: 'Compose a new document'
  }
];

interface KnowledgeNavigationProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function KnowledgeNavigation({ isCollapsed, onToggleCollapse }: KnowledgeNavigationProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { openDocuments, removeDocument, reorderDocuments } = useOpenDocuments();

  // Setup drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Function to close a document tab
  const closeDocument = (docId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    removeDocument(docId);

    // If we're closing the currently viewed document, navigate to Discover
    if (pathname === `/know/document/${docId}`) {
      router.push('/know/discover');
    }
  };

  // Handle drag end
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = openDocuments.findIndex((doc) => doc.id === active.id);
      const newIndex = openDocuments.findIndex((doc) => doc.id === over.id);
      reorderDocuments(oldIndex, newIndex);
    }
  };

  return (
    <>
      {/* Screen reader instructions for drag and drop */}
      <div id="drag-instructions" className="sr-only">
        Press space bar to pick up the item. Use arrow keys to move it. Press space bar again to drop.
      </div>
      <div className={`${isCollapsed ? 'p-2' : 'p-4'}`}>
        <div className="space-y-1">
          <div>
            {/* Header with collapse button - fixed height for alignment */}
            <div className="h-12 flex items-center mb-3">
              {!isCollapsed ? (
                <>
                  <div className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider flex-1">
                    Knowledge
                  </div>
                  <button
                    onClick={onToggleCollapse}
                    className="p-2 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors border border-gray-300 dark:border-gray-600 flex-shrink-0"
                    title="Collapse sidebar"
                    aria-label="Collapse sidebar"
                  >
                    <ChevronLeftIcon className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                  </button>
                </>
              ) : (
                <button
                  onClick={onToggleCollapse}
                  className="p-2 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors border border-gray-300 dark:border-gray-600 mx-auto"
                  title="Expand sidebar"
                  aria-label="Expand sidebar"
                >
                  <Bars3Icon className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                </button>
              )}
            </div>

            {/* Navigation content */}
            <div id="knowledge-nav-content">
            {/* Fixed navigation items */}
            {fixedNavigation.map((item) => {
              const isActive = pathname === item.href;

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`group flex items-center ${
                    isCollapsed ? 'justify-center px-2' : 'px-3'
                  } py-2 text-sm font-medium rounded-md transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                      : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                  title={isCollapsed ? item.name : item.description}
                >
                  <item.icon
                    className={`flex-shrink-0 h-5 w-5 ${
                      isCollapsed ? '' : '-ml-1 mr-3'
                    } ${
                      isActive
                        ? 'text-blue-500 dark:text-blue-400'
                        : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
                    }`}
                  />
                  {!isCollapsed && item.name}
                </Link>
              );
            })}
            
            {/* Document tabs with drag and drop */}
            {isCollapsed ? (
              // When collapsed, dragging is disabled - just render simple tabs
              openDocuments.map((doc) => (
                <SortableDocumentTab
                  key={doc.id}
                  doc={doc}
                  isCollapsed={isCollapsed}
                  onClose={closeDocument}
                />
              ))
            ) : (
              // When expanded, enable drag and drop
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={openDocuments.map((doc) => doc.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {openDocuments.map((doc) => (
                    <SortableDocumentTab
                      key={doc.id}
                      doc={doc}
                      isCollapsed={isCollapsed}
                      onClose={closeDocument}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}