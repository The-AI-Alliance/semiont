'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PopupContainer, PopupHeader, SelectedTextDisplay, EntityTypeBadges } from './SharedPopupElements';
import { SearchDocumentsModal } from '../modals/SearchDocumentsModal';
import { buttonStyles } from '@/lib/button-styles';
import type { ReferenceAnnotation, AnnotationUpdate, TextSelection } from '@semiont/core-types';

interface StubReferencePopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: TextSelection;
  annotation: ReferenceAnnotation;
  onUpdateAnnotation: (updates: AnnotationUpdate) => void;
  onDeleteAnnotation: () => void;
  onGenerateDocument?: (title: string, prompt?: string) => void;
}

export function StubReferencePopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onGenerateDocument,
}: StubReferencePopupProps) {
  const router = useRouter();
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerateDocument = async () => {
    if (!onGenerateDocument || !selection) return;

    setIsGenerating(true);
    try {
      onGenerateDocument(selection.text);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSearchDocuments = () => {
    setShowSearchModal(true);
  };

  const handleSelectDocument = (documentId: string) => {
    onUpdateAnnotation({
      resolvedDocumentId: documentId,
    });
    setShowSearchModal(false);
  };

  const handleComposeDocument = () => {
    if (selection) {
      router.push(`/know/compose?title=${encodeURIComponent(selection.text)}`);
      onClose();
    }
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
    <>
      <PopupContainer position={position} onClose={onClose} isOpen={isOpen}>
        <PopupHeader title="Stub Reference" onClose={onClose} />

        <SelectedTextDisplay text={selection.text} />

        {annotation.entityType && (
          <EntityTypeBadges entityTypes={annotation.entityType} />
        )}

        {annotation.referenceType && (
          <div className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            Reference Type: <span className="font-medium">{annotation.referenceType}</span>
          </div>
        )}

        {/* Link Options */}
        <div className="mb-4">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Link to Document
          </p>
          <div className="space-y-2">
            <button
              onClick={handleGenerateDocument}
              disabled={isGenerating}
              className={`${buttonStyles.primary.base} w-full justify-center`}
            >
              {isGenerating ? (
                <span className="flex items-center justify-center">
                  <span className="animate-spin mr-2">⏳</span>
                  Generating...
                </span>
              ) : (
                '✨ Generate'
              )}
            </button>
            <button
              onClick={handleSearchDocuments}
              className={`${buttonStyles.secondary.base} w-full justify-center`}
            >
              🔍 Search
            </button>
            <button
              onClick={handleComposeDocument}
              className={`${buttonStyles.secondary.base} w-full justify-center`}
            >
              ✏️ Compose New
            </button>
          </div>
        </div>

        {/* Other Actions */}
        <div className="space-y-2 pt-3 border-t border-gray-200 dark:border-gray-700">
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

      {/* Search Modal */}
      <SearchDocumentsModal
        isOpen={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        onSelect={handleSelectDocument}
        searchTerm={selection.text}
      />
    </>
  );
}