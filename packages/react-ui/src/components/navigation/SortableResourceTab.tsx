'use client';

import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getResourceIcon } from '../../utils/resource-icons';
import type { SortableResourceTabProps } from '../../types/collapsible-navigation';

/**
 * A sortable tab for an open resource in the navigation sidebar.
 * Supports drag and drop when expanded, and compact icon-only view when collapsed.
 */
export function SortableResourceTab({
  resource,
  isCollapsed,
  isActive,
  href,
  onClose,
  LinkComponent,
  translations = {},
  dragHandleProps,
  isDragging = false
}: SortableResourceTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: resource.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isSortableDragging || isDragging ? 0.5 : 1,
  };

  const resourceIcon = getResourceIcon(resource.mediaType);
  const isCurrentlyDragging = isSortableDragging || isDragging;

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="tab"
      aria-selected={isActive}
      className={`sortable-resource-tab group flex items-center ${
        isCollapsed ? 'justify-center px-2' : 'px-3'
      } py-2 text-sm font-medium rounded-md transition-colors ${
        isActive
          ? 'sortable-resource-tab--active bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
          : 'sortable-resource-tab--inactive text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
      } ${isCurrentlyDragging ? 'sortable-resource-tab--dragging z-50 shadow-lg' : ''}`}
    >
      {/* Document Link with Icon */}
      <LinkComponent
        href={href}
        className={`sortable-resource-tab__link flex items-center ${isCollapsed ? '' : 'flex-1 min-w-0'}`}
        title={resource.name}
      >
        {/* Document Icon - draggable when expanded, clickable when collapsed */}
        {!isCollapsed ? (
          <div
            {...attributes}
            {...listeners}
            className="sortable-resource-tab__drag-handle flex-shrink-0 -ml-1 mr-3 cursor-move"
            title={translations.dragToReorder || 'Drag to reorder'}
            aria-label={translations.dragToReorderDoc?.replace('{name}', resource.name) || `Drag to reorder ${resource.name}`}
            aria-describedby="drag-instructions"
            role="button"
            tabIndex={0}
            onClick={(e: React.MouseEvent) => {
              // Prevent navigation when dragging
              if (isCurrentlyDragging) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <span className="text-base" aria-hidden="true">{resourceIcon}</span>
          </div>
        ) : (
          // When collapsed, icon is clickable for navigation
          <span className="sortable-resource-tab__icon flex-shrink-0 text-base" aria-hidden="true">
            {resourceIcon}
          </span>
        )}
        {!isCollapsed && (
          <span className="sortable-resource-tab__name truncate">{resource.name}</span>
        )}
      </LinkComponent>

      {/* Close Button - only visible when not collapsed */}
      {!isCollapsed && (
        <button
          onClick={(e) => onClose(resource.id, e)}
          className="sortable-resource-tab__close ml-1 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title={translations.closeResource || 'Close resource'}
          aria-label={`Close ${resource.name}`}
        >
          <svg className="h-3 w-3 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}