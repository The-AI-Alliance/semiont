'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader } from './SharedPopupElements';
import { JsonLdButton } from './JsonLdButton';
import { JsonLdView } from './JsonLdView';
import { buttonStyles } from '@/lib/button-styles';
import type { HighlightAnnotation, AnnotationUpdate, TextSelection } from '@/lib/api';

interface HighlightPopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: TextSelection;
  annotation: HighlightAnnotation;
  onUpdateAnnotation: (updates: AnnotationUpdate) => void;
  onDeleteAnnotation: () => void;
}

export function HighlightPopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: HighlightPopupProps) {
  const t = useTranslations('HighlightPopup');
  const [showJsonLd, setShowJsonLd] = useState(false);

  const handleConvertToReference = () => {
    onUpdateAnnotation({
      body: {
        type: 'SpecificResource',
      },
    });
  };

  const handleDelete = () => {
    onDeleteAnnotation();
    onClose();
  };

  return (
    <PopupContainer position={position} onClose={onClose} isOpen={isOpen}>
      {showJsonLd ? (
        <JsonLdView annotation={annotation} onBack={() => setShowJsonLd(false)} />
      ) : (
        <>
          <PopupHeader title={t('title')} selectedText={selection.exact} onClose={onClose} />

          {/* Actions */}
          <div className="space-y-2">
            <button
              onClick={handleConvertToReference}
              className={`${buttonStyles.primary.base} w-full justify-center`}
            >
              🔗 {t('convertToReference')}
            </button>

            <button
              onClick={handleDelete}
              className={`${buttonStyles.danger.base} w-full justify-center`}
            >
              🗑️ {t('deleteHighlight')}
            </button>

            <JsonLdButton onClick={() => setShowJsonLd(true)} />
          </div>
        </>
      )}
    </PopupContainer>
  );
}