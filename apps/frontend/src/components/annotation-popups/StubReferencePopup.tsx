'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader, EntityTypeBadges } from './SharedPopupElements';
import { SearchResourcesModal } from '../modals/SearchResourcesModal';
import { JsonLdButton } from './JsonLdButton';
import { JsonLdView } from './JsonLdView';
import { buttonStyles } from '@/lib/button-styles';
import type { components } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';

type ReferenceAnnotation = components['schemas']['Annotation'];
type AnnotationUpdate = Partial<components['schemas']['Annotation']>;
type TextSelection = { exact: string; start: number; end: number };

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
  const [showJsonLd, setShowJsonLd] = useState(false);

  // Calculate centered position when showing JSON-LD
  const displayPosition = useMemo(() => {
    if (!showJsonLd || typeof window === 'undefined') return position;

    const popupWidth = 800;
    const popupHeight = 700;

    return {
      x: Math.max(0, (window.innerWidth - popupWidth) / 2),
      y: Math.max(0, (window.innerHeight - popupHeight) / 2),
    };
  }, [showJsonLd, position]);

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
    // Link to selected document using SpecificResource
    onUpdateAnnotation({
      body: {
        type: 'SpecificResource' as const,
        source: documentId,
        purpose: 'linking' as const,
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
    // Convert to highlighting motivation with empty body
    onUpdateAnnotation({
      motivation: 'highlighting',
      body: [],
    });
  };

  const handleDelete = () => {
    onDeleteAnnotation();
    onClose();
  };

  return (
    <>
      <PopupContainer position={displayPosition} onClose={onClose} isOpen={isOpen} wide={showJsonLd}>
        {showJsonLd ? (
          <JsonLdView annotation={annotation} onBack={() => setShowJsonLd(false)} />
        ) : (
          <>
            <PopupHeader title={t('title')} selectedText={selection.exact} onClose={onClose} />

            {(() => {
              const entityTypes = getEntityTypes(annotation);
              return entityTypes.length > 0 && (
                <EntityTypeBadges entityTypes={entityTypes.join(', ')} />
              );
            })()}

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
                className={`${buttonStyles.secondary.base} w-full justify-center`}
              >
                🟡 {t('convertToHighlight')}
              </button>
              <button
                onClick={handleDelete}
                className={`${buttonStyles.danger.base} w-full justify-center`}
              >
                🗑️ {t('deleteReference')}
              </button>
              <JsonLdButton onClick={() => setShowJsonLd(true)} />
            </div>
          </>
        )}
      </PopupContainer>

      {/* Search Modal */}
      <SearchResourcesModal
        isOpen={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        onSelect={handleSelectDocument}
        searchTerm={selection.exact}
      />
    </>
  );
}