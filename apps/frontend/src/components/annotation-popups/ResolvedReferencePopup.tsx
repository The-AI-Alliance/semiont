'use client';

import React from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader, SelectedTextDisplay, EntityTypeBadges } from './SharedPopupElements';
import { buttonStyles } from '@/lib/button-styles';
import type { ReferenceAnnotation, AnnotationUpdate, TextSelection } from '@semiont/sdk';

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
  const resolvedDocumentId = annotation.body.source;

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
    onUpdateAnnotation({
      body: {
        source: null,
      },
    });
  };

  const handleConvertToHighlight = () => {
    onUpdateAnnotation({
      body: {
        type: 'TextualBody',
        entityTypes: null,
        source: null,
      },
    });
  };

  const handleDelete = () => {
    onDeleteAnnotation();
    onClose();
    };

  return (
    <PopupContainer position={position} onClose={onClose} isOpen={isOpen}>
      <PopupHeader title={t('title')} onClose={onClose} />

      <SelectedTextDisplay exact={selection.exact} />

      {annotation.body.entityTypes && annotation.body.entityTypes.length > 0 && (
        <EntityTypeBadges entityTypes={annotation.body.entityTypes.join(', ')} />
      )}


      {/* Resolved Document Info */}
      <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
        <p className="text-sm font-medium text-blue-900 dark:text-blue-200 mb-1">
          {t('resolvedTo')}
        </p>
        <p className="text-sm text-blue-700 dark:text-blue-300">
          {documentName || resolvedDocumentId || t('document')}
        </p>
      </div>

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
          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
        >
          🔗 {t('unlinkDocument')}
        </button>
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
  );
}