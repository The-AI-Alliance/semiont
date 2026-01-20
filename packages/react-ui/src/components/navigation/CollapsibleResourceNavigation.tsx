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
import { useTranslations } from '../../contexts/TranslationContext';
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
  const t = useTranslations('CollapsibleResourceNavigation');

  // Use translations from context, with fallback to props for backward compatibility
  const mergedTranslations = {
    title: translations?.title || t('title'),
    collapseSidebar: translations?.collapseSidebar || t('collapseSidebar'),
    expandSidebar: translations?.expandSidebar || t('expandSidebar'),
    dragToReorder: translations?.dragToReorder || t('dragToReorder'),
    dragToReorderDoc: translations?.dragToReorderDoc || t('dragToReorderDoc'),
    closeResource: translations?.closeResource || t('closeResource'),
    dragInstructions: translations?.dragInstructions || t('dragInstructions')
  };

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
    <div className={`semiont-collapsible-nav ${className}`}>
      {/* Screen reader instructions for drag and drop */}
      <div id="drag-instructions" className="sr-only" aria-live="polite">
        {mergedTranslations.dragInstructions}
      </div>

      {/* Keyboard reordering instructions (announced once) */}
      <div className="sr-only" role="status" aria-atomic="true">
        Resources can be reordered using Alt+Up or Alt+Down arrow keys.
      </div>

      <div className="semiont-collapsible-nav__container">
        <div className="semiont-collapsible-nav__list">
          <div>
            {/* Header with collapse button - fixed height for alignment */}
            <div className="semiont-collapsible-nav__header">
              {!isCollapsed ? (
                <>
                  <div className="semiont-nav-header__title">
                    {mergedTranslations.title}
                  </div>
                  <button
                    onClick={onToggleCollapse}
                    className="semiont-collapsible-nav__collapse-btn"
                    title={mergedTranslations.collapseSidebar}
                    aria-label={mergedTranslations.collapseSidebar}
                  >
                    <ChevronLeftIcon />
                  </button>
                </>
              ) : (
                <button
                  onClick={onToggleCollapse}
                  className="semiont-collapsible-nav__expand-btn"
                  title={mergedTranslations.expandSidebar}
                  aria-label={mergedTranslations.expandSidebar}
                >
                  <BarsIcon />
                </button>
              )}
            </div>

            {/* Navigation content */}
            <div className="semiont-collapsible-nav__content">
              {/* Fixed navigation items using SidebarNavigation */}
              <SidebarNavigation
                items={fixedItems}
                currentPath={currentPath}
                LinkComponent={LinkComponent}
                isCollapsed={isCollapsed}
                showDescriptions={!isCollapsed}
                activeClassName={activeClassName}
                inactiveClassName={inactiveClassName}
              />

              {/* Resource tabs with drag and drop */}
              <div className="semiont-collapsible-nav__resources" role="tablist" aria-label="Open resources">
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
                          dragToReorder: mergedTranslations.dragToReorder,
                          dragToReorderDoc: mergedTranslations.dragToReorderDoc,
                          closeResource: mergedTranslations.closeResource
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
                              dragToReorder: mergedTranslations.dragToReorder,
                              dragToReorderDoc: mergedTranslations.dragToReorderDoc,
                              closeResource: mergedTranslations.closeResource
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