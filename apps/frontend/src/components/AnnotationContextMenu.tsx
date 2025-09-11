"use client";

import React, { useEffect, useRef } from 'react';

interface AnnotationContextMenuProps {
  x: number;
  y: number;
  annotation: {
    id: string;
    type: 'highlight' | 'reference';
    referencedDocumentId?: string;
  };
  onClose: () => void;
  onDelete: () => void;
  onConvertToReference?: () => void;
  onConvertToHighlight?: () => void;
  onEditReference?: () => void;
}

export function AnnotationContextMenu({
  x,
  y,
  annotation,
  onClose,
  onDelete,
  onConvertToReference,
  onConvertToHighlight,
  onEditReference,
}: AnnotationContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 min-w-[200px]"
      style={{ left: x, top: y }}
    >
      {annotation.type === 'highlight' && onConvertToReference && (
        <button
          onClick={() => {
            onConvertToReference();
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <span className="text-blue-600 dark:text-blue-400">🔗</span>
          Convert to Reference
        </button>
      )}

      {annotation.type === 'reference' && onConvertToHighlight && (
        <button
          onClick={() => {
            onConvertToHighlight();
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <span className="text-yellow-600 dark:text-yellow-400">🖍</span>
          Convert to Highlight
        </button>
      )}

      {annotation.type === 'reference' && onEditReference && (
        <button
          onClick={() => {
            onEditReference();
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <span className="text-gray-600 dark:text-gray-400">✏️</span>
          Edit Reference
        </button>
      )}

      {(annotation.type === 'highlight' || annotation.type === 'reference') && (
        <>
          <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
          <button
            onClick={() => {
              onDelete();
              onClose();
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 flex items-center gap-2"
          >
            <span>🗑️</span>
            Delete
          </button>
        </>
      )}
    </div>
  );
}