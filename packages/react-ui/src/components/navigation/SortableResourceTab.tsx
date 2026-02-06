'use client';

import React, { useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getResourceIcon } from '../../lib/resource-utils';
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

  const iconEmoji = getResourceIcon(resource.mediaType);
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      aria-selected={isActive}
      onKeyDown={handleKeyDown}
      aria-label={`${resource.name}, position ${index !== undefined ? index + 1 : ''} of ${totalCount || ''}`}
      className={`semiont-resource-tab ${isActive ? 'semiont-resource-tab--active' : ''} ${isCurrentlyDragging ? 'semiont-resource-tab--dragging' : ''}`}
      role="tab"
    >
      {/* Document Link with Icon */}
      <LinkComponent
        href={href}
        className="semiont-resource-tab__link"
        title={resource.name}
      >
        <span className="semiont-resource-tab__icon" aria-hidden="true">
          {iconEmoji}
        </span>
        {!isCollapsed && (
          <span className="semiont-resource-tab__text">{resource.name}</span>
        )}
      </LinkComponent>

      {/* Close button - only visible when not collapsed */}
      {!isCollapsed && (
        <button
          onClick={(e) => onClose(resource.id, e)}
          className="semiont-resource-tab__close"
          title={translations.closeResource || 'Close resource'}
          aria-label={`Close ${resource.name}`}
          type="button"
        >
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}