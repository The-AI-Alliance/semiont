'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader, EntityTypeBadges } from './SharedPopupElements';
import { JsonLdButton } from './JsonLdButton';
import { JsonLdView } from './JsonLdView';
import { buttonStyles } from '@/lib/button-styles';
import { getBodySource, getEntityTypes } from '@semiont/api-client';
import type { components } from '@semiont/api-client';

type ReferenceAnnotation = components['schemas']['Annotation'];
type AnnotationUpdate = Partial<components['schemas']['Annotation']>;
type TextSelection = { exact: string; start: number; end: number };

interface ResolvedReferencePopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: TextSelection;
  annotation: ReferenceAnnotation;
  documentName?: string;  // Optional document name fetched from API
  onUpdateAnnotation: (updates: AnnotationUpdate) => void;
  onDeleteAnnotation: () => void;
}

export function ResolvedReferencePopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  documentName,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: ResolvedReferencePopupProps) {
  const t = useTranslations('ResolvedReferencePopup');
  const router = useRouter();
  const [showJsonLd, setShowJsonLd] = useState(false);
  const resolvedDocumentId = getBodySource(annotation.body);

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

  const handleViewDocument = () => {
    if (resolvedDocumentId) {
      router.push(`/know/document/${encodeURIComponent(resolvedDocumentId)}`);
      onClose();
    }
  };

  const handleOpenInNewTab = () => {
    if (resolvedDocumentId) {
      window.open(`/know/document/${encodeURIComponent(resolvedDocumentId)}`, '_blank');
    }
  };

  const handleCopyLinkText = async () => {
    try {
      await navigator.clipboard.writeText(selection.exact);
    } catch (err) {
      console.error('Failed to copy exact:', err);
    }
  };

  const handleUnlinkDocument = () => {
    // Unlink converts to stub reference (empty body array)
    onUpdateAnnotation({
      body: [],
    });
  };

  const handleConvertToHighlight = () => {
    // Convert reference to highlight
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

          {/* Primary Actions */}
          <div className="mb-4">
            <div className="flex gap-2">
              <button
                onClick={handleOpenInNewTab}
                className={`${buttonStyles.primary.base} flex-1 justify-center`}
              >
                🔗 {t('openInNewTab')}
              </button>
              <button
                onClick={handleCopyLinkText}
                className={`${buttonStyles.secondary.base} px-3 flex items-center justify-center`}
                title={t('copyLinkText')}
              >
                📋
              </button>
            </div>
          </div>

          {/* Secondary Actions */}
          <div className="space-y-2 pt-3 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleUnlinkDocument}
              className={`${buttonStyles.secondary.base} w-full justify-center`}
            >
              ⛓️‍💥 {t('unlinkDocument')}
            </button>
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
  );
}