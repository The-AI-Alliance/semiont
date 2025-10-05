'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { PopupContainer, PopupHeader, SelectedTextDisplay, EntityTypeBadges } from './SharedPopupElements';
import { buttonStyles } from '@/lib/button-styles';
import type { ReferenceAnnotation, AnnotationUpdate, TextSelection } from '@/types/annotation';

interface ResolvedReferencePopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: TextSelection;
  annotation: ReferenceAnnotation & { resolvedDocumentId: string };
  onUpdateAnnotation: (updates: AnnotationUpdate) => void;
  onDeleteAnnotation: () => void;
}

export function ResolvedReferencePopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: ResolvedReferencePopupProps) {
  const router = useRouter();

  const handleViewDocument = () => {
    if (annotation.resolvedDocumentId) {
      router.push(`/know/document/${encodeURIComponent(annotation.resolvedDocumentId)}`);
      onClose();
    }
  };

  const handleOpenInNewTab = () => {
    if (annotation.resolvedDocumentId) {
      window.open(`/know/document/${encodeURIComponent(annotation.resolvedDocumentId)}`, '_blank');
    }
  };

  const handleCopyLinkText = async () => {
    try {
      await navigator.clipboard.writeText(selection.text);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  const handleUnlinkDocument = () => {
    onUpdateAnnotation({
      resolvedDocumentId: null,
    });
  };

  const handleConvertToHighlight = () => {
    onUpdateAnnotation({
      type: 'highlight',
      entityType: null,
      referenceType: null,
      resolvedDocumentId: null,
    });
  };

  const handleDelete = () => {
    onDeleteAnnotation();
    onClose();
  };

  return (
    <PopupContainer position={position} onClose={onClose} isOpen={isOpen}>
      <PopupHeader title="Resolved Reference" onClose={onClose} />

      <SelectedTextDisplay text={selection.text} />

      {annotation.entityType && (
        <EntityTypeBadges entityTypes={annotation.entityType} />
      )}

      {annotation.referenceType && (
        <div className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          Reference Type: <span className="font-medium">{annotation.referenceType}</span>
        </div>
      )}

      {/* Resolved Document Info */}
      <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
        <p className="text-sm font-medium text-blue-900 dark:text-blue-200 mb-1">
          Resolved to:
        </p>
        <p className="text-sm text-blue-700 dark:text-blue-300">
          {annotation.resolvedDocumentName || 'Document'}
        </p>
      </div>

      {/* Primary Actions */}
      <div className="mb-4">
        <div className="flex gap-2">
          <button
            onClick={handleOpenInNewTab}
            className={`${buttonStyles.primary.base} flex-1 justify-center`}
          >
            🔗 Open in New Tab
          </button>
          <button
            onClick={handleCopyLinkText}
            className={`${buttonStyles.secondary.base} px-3 flex items-center justify-center`}
            title="Copy link text"
          >
            📋
          </button>
        </div>
      </div>

      {/* Secondary Actions */}
      <div className="space-y-2 pt-3 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={handleUnlinkDocument}
          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
        >
          🔗 Unlink Document
        </button>
        <button
          onClick={handleConvertToHighlight}
          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
        >
          🖍 Convert to Highlight
        </button>
        <button
          onClick={handleDelete}
          className="w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
        >
          🗑️ Delete Reference
        </button>
      </div>
    </PopupContainer>
  );
}