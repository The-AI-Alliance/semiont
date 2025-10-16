'use client';

import React, { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader, SelectedTextDisplay, EntityTypeBadges } from './SharedPopupElements';
import { SearchDocumentsModal } from '../modals/SearchDocumentsModal';
import { buttonStyles } from '@/lib/button-styles';
import type { ReferenceAnnotation, AnnotationUpdate, TextSelection } from '@/lib/api';

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
  const t = useTranslations('StubReferencePopup');
  const router = useRouter();
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerateDocument = async () => {
    if (!onGenerateDocument || !selection) return;

    setIsGenerating(true);
    try {
      onGenerateDocument(selection.exact);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSearchDocuments = () => {
    setShowSearchModal(true);
  };

  const handleSelectDocument = (documentId: string) => {
    onUpdateAnnotation({
      body: {
        type: 'SpecificResource' as const,
        source: documentId,
      },
    });
    setShowSearchModal(false);
  };

  const handleComposeDocument = () => {
    if (selection) {
      router.push(`/know/compose?title=${encodeURIComponent(selection.exact)}`);
      onClose();
    }
  };

  const handleConvertToHighlight = () => {
    onUpdateAnnotation({
      body: {
        type: 'TextualBody',
        source: null,
      },
    });
  };

  const handleDelete = () => {
    onDeleteAnnotation();
    onClose();
  };

  return (
    <>
      <PopupContainer position={position} onClose={onClose} isOpen={isOpen}>
        <PopupHeader title={t('title')} onClose={onClose} />

        <SelectedTextDisplay exact={selection.exact} />

        {annotation.body.entityTypes && annotation.body.entityTypes.length > 0 && (
          <EntityTypeBadges entityTypes={annotation.body.entityTypes.join(', ')} />
        )}

        {/* Link Options */}
        <div className="mb-4">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('linkToDocument')}
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
                  {t('generating')}
                </span>
              ) : (
                `✨ ${t('generate')}`
              )}
            </button>
            <button
              onClick={handleSearchDocuments}
              className={`${buttonStyles.secondary.base} w-full justify-center`}
            >
              🔍 {t('search')}
            </button>
            <button
              onClick={handleComposeDocument}
              className={`${buttonStyles.secondary.base} w-full justify-center`}
            >
              ✏️ {t('composeNew')}
            </button>
          </div>
        </div>

        {/* Other Actions */}
        <div className="space-y-2 pt-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleConvertToHighlight}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
          >
            🖍 {t('convertToHighlight')}
          </button>
          <button
            onClick={handleDelete}
            className="w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
          >
            🗑️ {t('deleteReference')}
          </button>
        </div>
      </PopupContainer>

      {/* Search Modal */}
      <SearchDocumentsModal
        isOpen={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        onSelect={handleSelectDocument}
        searchTerm={selection.exact}
      />
    </>
  );
}