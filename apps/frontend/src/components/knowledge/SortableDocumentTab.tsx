'use client';

import React from 'react';
import { usePathname } from '@/i18n/routing';
import { Link } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DocumentTextIcon, XMarkIcon } from '@heroicons/react/24/outline';

interface OpenDocument {
  id: string;
  name: string;
  openedAt: number;
}

interface SortableDocumentTabProps {
  doc: OpenDocument;
  isCollapsed: boolean;
  onClose: (id: string, e: React.MouseEvent) => void;
}

export function SortableDocumentTab({ doc, isCollapsed, onClose }: SortableDocumentTabProps) {
  const t = useTranslations('SortableDocumentTab');
  const pathname = usePathname();
  const docHref = `/know/document/${doc.id}`;
  const isActive = pathname === docHref;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: doc.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center ${
        isCollapsed ? 'justify-center px-2' : 'px-3'
      } py-2 text-sm font-medium rounded-md transition-colors ${
        isActive
          ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
          : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
      } ${isDragging ? 'z-50 shadow-lg' : ''}`}
    >
      {/* Document Link with Icon */}
      <Link
        href={docHref}
        className={`flex items-center ${isCollapsed ? '' : 'flex-1 min-w-0'}`}
        title={doc.name}
      >
        {/* Document Icon - draggable when expanded, clickable when collapsed */}
        {!isCollapsed ? (
          <div
            {...attributes}
            {...listeners}
            className="flex-shrink-0 -ml-1 mr-3 cursor-move"
            title={t('dragToReorder')}
            aria-label={t('dragToReorderDoc', { name: doc.name })}
            aria-describedby="drag-instructions"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              // Prevent navigation when dragging
              if (isDragging) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <DocumentTextIcon
              className={`h-5 w-5 ${
                isActive
                  ? 'text-blue-500 dark:text-blue-400'
                  : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
              }`}
            />
          </div>
        ) : (
          // When collapsed, icon is clickable for navigation
          <DocumentTextIcon
            className={`flex-shrink-0 h-5 w-5 ${
              isActive
                ? 'text-blue-500 dark:text-blue-400'
                : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
            }`}
          />
        )}
        {!isCollapsed && <span className="truncate">{doc.name}</span>}
      </Link>

      {/* Close Button - only visible when not collapsed */}
      {!isCollapsed && (
        <button
          onClick={(e) => onClose(doc.id, e)}
          className="ml-1 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title={t('closeDocument')}
        >
          <XMarkIcon className="h-3 w-3 text-gray-500 dark:text-gray-400" />
        </button>
      )}
    </div>
  );
}