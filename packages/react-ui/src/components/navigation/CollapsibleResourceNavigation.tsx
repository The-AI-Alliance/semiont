'use client';

import React, { useCallback, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { SidebarNavigation } from './SidebarNavigation';
import { SortableResourceTab } from './SortableResourceTab';
import { useDragAnnouncements } from '../../hooks/useDragAnnouncements';
import type { CollapsibleResourceNavigationProps } from '../../types/collapsible-navigation';

/**
 * A comprehensive collapsible navigation component with fixed items and dynamic resource tabs.
 * Supports drag and drop for resource reordering when expanded.
 * Platform-agnostic design for use across different React environments.
 */
export function CollapsibleResourceNavigation({
  fixedItems,
  resources,
  isCollapsed,
  onToggleCollapse,
  onResourceClose,
  onResourceReorder,
  onResourceSelect,
  currentPath,
  LinkComponent,
  onNavigate,
  getResourceHref,
  className = '',
  activeClassName,
  inactiveClassName,
  translations = {},
  icons
}: CollapsibleResourceNavigationProps) {
  const ChevronLeftIcon = icons.chevronLeft;
  const BarsIcon = icons.bars;
  const CloseIcon = icons.close;

  const { announcePickup, announceDrop, announceKeyboardReorder, announceCannotMove } = useDragAnnouncements();

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

  // Handle keyboard reordering (Alt+Up/Down arrows)
  const handleKeyboardReorder = useCallback((resourceId: string, direction: 'up' | 'down') => {
    const currentIndex = resources.findIndex(r => r.id === resourceId);
    if (currentIndex === -1) return;

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

    // Check bounds
    if (newIndex < 0 || newIndex >= resources.length) {
      announceCannotMove(direction);
      return;
    }

    // Perform reorder
    onResourceReorder(currentIndex, newIndex);

    // Announce the change
    const resource = resources[currentIndex];
    announceKeyboardReorder(resource.name, direction, newIndex + 1, resources.length);
  }, [resources, onResourceReorder, announceKeyboardReorder, announceCannotMove]);

  // Handle resource close
  const handleResourceClose = (resourceId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    onResourceClose(resourceId);

    // If we're closing the currently viewed resource, navigate to first fixed item or trigger callback
    const resourceHref = getResourceHref(resourceId);
    if (currentPath === resourceHref && onNavigate && fixedItems.length > 0) {
      onNavigate(fixedItems[0].href);
    }
  };

  // Handle drag start
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const resource = resources.find(r => r.id === active.id);
    if (resource) {
      const index = resources.indexOf(resource);
      announcePickup(resource.name, index + 1, resources.length);
    }
  };

  // Handle drag end for resource reordering
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = resources.findIndex((resource) => resource.id === active.id);
      const newIndex = resources.findIndex((resource) => resource.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        onResourceReorder(oldIndex, newIndex);
        const resource = resources[oldIndex];
        announceDrop(resource.name, newIndex + 1, resources.length);
      }
    }
  };

  return (
    <div className={`collapsible-resource-navigation ${className}`}>
      {/* Screen reader instructions for drag and drop */}
      <div id="drag-instructions" className="sr-only" aria-live="polite">
        {translations.dragInstructions ||
         'To reorder resources: Use Tab to navigate to a resource. Press Alt+Up arrow to move up or Alt+Down arrow to move down. For drag and drop: Press space bar to pick up the item. Use arrow keys to move it. Press space bar again to drop.'}
      </div>

      {/* Keyboard reordering instructions (announced once) */}
      <div className="sr-only" role="status" aria-atomic="true">
        Resources can be reordered using Alt+Up or Alt+Down arrow keys.
      </div>

      <div className={`${isCollapsed ? 'p-2' : 'p-4'}`}>
        <div className="space-y-1">
          <div>
            {/* Header with collapse button - fixed height for alignment */}
            <div className="collapsible-resource-navigation__header h-12 flex items-center mb-3">
              {!isCollapsed ? (
                <>
                  <div className="collapsible-resource-navigation__title text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider flex-1">
                    {translations.title || 'Navigation'}
                  </div>
                  <button
                    onClick={onToggleCollapse}
                    className="collapsible-resource-navigation__collapse-btn p-2 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors border border-gray-300 dark:border-gray-600 flex-shrink-0"
                    title={translations.collapseSidebar || 'Collapse sidebar'}
                    aria-label={translations.collapseSidebar || 'Collapse sidebar'}
                  >
                    <ChevronLeftIcon className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                  </button>
                </>
              ) : (
                <button
                  onClick={onToggleCollapse}
                  className="collapsible-resource-navigation__expand-btn p-2 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors border border-gray-300 dark:border-gray-600 mx-auto"
                  title={translations.expandSidebar || 'Expand sidebar'}
                  aria-label={translations.expandSidebar || 'Expand sidebar'}
                >
                  <BarsIcon className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                </button>
              )}
            </div>

            {/* Navigation content */}
            <div className="collapsible-resource-navigation__content">
              {/* Fixed navigation items using SidebarNavigation */}
              <SidebarNavigation
                items={fixedItems}
                currentPath={currentPath}
                LinkComponent={LinkComponent}
                isCollapsed={isCollapsed}
                showDescriptions={!isCollapsed}
                activeClassName={activeClassName || 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors'}
                inactiveClassName={inactiveClassName || 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800 group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors'}
              />

              {/* Resource tabs with drag and drop */}
              <div className="collapsible-resource-navigation__resources mt-3" role="tablist" aria-label="Open resources">
                {isCollapsed ? (
                  // When collapsed, dragging is disabled - just render simple tabs
                  resources.map((resource) => {
                    const resourceHref = getResourceHref(resource.id);
                    const isActive = currentPath === resourceHref;

                    return (
                      <SortableResourceTab
                        key={resource.id}
                        resource={resource}
                        isCollapsed={isCollapsed}
                        isActive={isActive}
                        href={resourceHref}
                        onClose={handleResourceClose}
                        LinkComponent={LinkComponent}
                        translations={{
                          dragToReorder: translations.dragToReorder,
                          dragToReorderDoc: translations.dragToReorderDoc,
                          closeResource: translations.closeResource
                        }}
                      />
                    );
                  })
                ) : (
                  // When expanded, enable drag and drop
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={resources.map((resource) => resource.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {resources.map((resource, index) => {
                        const resourceHref = getResourceHref(resource.id);
                        const isActive = currentPath === resourceHref;

                        return (
                          <SortableResourceTab
                            key={resource.id}
                            resource={resource}
                            isCollapsed={isCollapsed}
                            isActive={isActive}
                            href={resourceHref}
                            onClose={handleResourceClose}
                            onReorder={handleKeyboardReorder}
                            index={index}
                            totalCount={resources.length}
                            LinkComponent={LinkComponent}
                            translations={{
                              dragToReorder: translations.dragToReorder,
                              dragToReorderDoc: translations.dragToReorderDoc,
                              closeResource: translations.closeResource
                            }}
                          />
                        );
                      })}
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}