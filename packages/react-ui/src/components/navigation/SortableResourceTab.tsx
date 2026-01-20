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
      className={`semiont-resource-tab ${
        isCollapsed ? 'semiont-resource-tab--collapsed' : ''
      } ${
        isActive
          ? 'semiont-resource-tab--active'
          : 'semiont-resource-tab--inactive'
      } ${isCurrentlyDragging ? 'semiont-resource-tab--dragging' : ''}`}
    >
      {/* Document Link with Icon */}
      <LinkComponent
        href={href}
        className="semiont-resource-tab__link"
        title={resource.name}
      >
        {/* Document Icon - draggable when expanded, clickable when collapsed */}
        {!isCollapsed ? (
          <div
            {...attributes}
            {...listeners}
            className="semiont-resource-tab__drag-handle"
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
            <span aria-hidden="true"><IconComponent /></span>
          </div>
        ) : (
          // When collapsed, icon is clickable for navigation
          <span className="semiont-resource-tab__icon" aria-hidden="true">
            <IconComponent />
          </span>
        )}
        {!isCollapsed && (
          <span className="semiont-resource-tab__name">{resource.name}</span>
        )}
      </LinkComponent>

      {/* Action buttons - only visible when not collapsed */}
      {!isCollapsed && (
        <div className="semiont-resource-tab__actions">
          {/* Reorder buttons (alternative to drag & drop) */}
          {onReorder && (
            <div className="semiont-resource-tab__reorder-buttons">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  onReorder(resource.id, 'up');
                }}
                disabled={!canMoveUp}
                className="semiont-resource-tab__reorder-btn"
                title={translations.moveUp || 'Move up'}
                aria-label={`Move ${resource.name} up`}
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  onReorder(resource.id, 'down');
                }}
                disabled={!canMoveDown}
                className="semiont-resource-tab__reorder-btn"
                title={translations.moveDown || 'Move down'}
                aria-label={`Move ${resource.name} down`}
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          )}

          {/* Close button */}
          <button
            onClick={(e) => onClose(resource.id, e)}
            className="semiont-resource-tab__close"
            title={translations.closeResource || 'Close resource'}
            aria-label={`Close ${resource.name}`}
          >
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}