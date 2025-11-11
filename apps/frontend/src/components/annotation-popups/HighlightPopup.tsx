'use client';

import React, { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader } from './SharedPopupElements';
import { JsonLdButton } from './JsonLdButton';
import { JsonLdView } from './JsonLdView';
import { buttonStyles } from '@/lib/button-styles';
import type { components } from '@semiont/api-client';

type HighlightAnnotation = components['schemas']['Annotation'];
type TextSelection = { exact: string; start: number; end: number };

interface HighlightPopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: TextSelection;
  annotation: HighlightAnnotation;
  onDeleteAnnotation: () => void;
}

export function HighlightPopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  onDeleteAnnotation,
}: HighlightPopupProps) {
  const t = useTranslations('HighlightPopup');
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

          {/* Actions */}
          <div className="space-y-2">
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