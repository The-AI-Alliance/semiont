'use client';

import React, { useCallback } from 'react';
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
  onReorder,
  index,
  totalCount,
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

  const IconComponent = getResourceIcon(resource.mediaType);
  const isCurrentlyDragging = isSortableDragging || isDragging;

  // Handle keyboard shortcuts for reordering (Alt + Up/Down)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (onReorder && e.altKey) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        onReorder(resource.id, 'up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        onReorder(resource.id, 'down');
      }
    }
  }, [onReorder, resource.id]);

  const canMoveUp = index !== undefined && index > 0;
  const canMoveDown = index !== undefined && totalCount !== undefined && index < totalCount - 1;

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="tab"
      aria-selected={isActive}
      onKeyDown={handleKeyDown}
      aria-label={`${resource.name}, position ${index !== undefined ? index + 1 : ''} of ${totalCount || ''}`}
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
            <span className="text-base" aria-hidden="true"><IconComponent className="w-5 h-5" /></span>
          </div>
        ) : (
          // When collapsed, icon is clickable for navigation
          <span className="sortable-resource-tab__icon flex-shrink-0 text-base" aria-hidden="true">
            <IconComponent className="w-5 h-5" />
          </span>
        )}
        {!isCollapsed && (
          <span className="sortable-resource-tab__name truncate">{resource.name}</span>
        )}
      </LinkComponent>

      {/* Action buttons - only visible when not collapsed */}
      {!isCollapsed && (
        <div className="flex items-center ml-auto">
          {/* Reorder buttons (alternative to drag & drop) */}
          {onReorder && (
            <div className="sortable-resource-tab__reorder-buttons flex opacity-0 group-hover:opacity-100 transition-opacity mr-1">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  onReorder(resource.id, 'up');
                }}
                disabled={!canMoveUp}
                className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title={translations.moveUp || 'Move up'}
                aria-label={`Move ${resource.name} up`}
              >
                <svg className="h-3 w-3 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  onReorder(resource.id, 'down');
                }}
                disabled={!canMoveDown}
                className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title={translations.moveDown || 'Move down'}
                aria-label={`Move ${resource.name} down`}
              >
                <svg className="h-3 w-3 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          )}

          {/* Close button */}
          <button
            onClick={(e) => onClose(resource.id, e)}
            className="sortable-resource-tab__close p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
            title={translations.closeResource || 'Close resource'}
            aria-label={`Close ${resource.name}`}
          >
            <svg className="h-3 w-3 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}