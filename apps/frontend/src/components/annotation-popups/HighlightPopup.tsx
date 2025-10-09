'use client';

import React from 'react';
import { PopupContainer, PopupHeader, SelectedTextDisplay } from './SharedPopupElements';
import { buttonStyles } from '@/lib/button-styles';
import type { HighlightAnnotation, AnnotationUpdate, TextSelection } from '@semiont/core-types';

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
  annotation,  // eslint-disable-line @typescript-eslint/no-unused-vars
  onUpdateAnnotation,
  onDeleteAnnotation,
}: HighlightPopupProps) {
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
      <PopupHeader title="Highlight" onClose={onClose} />

      <SelectedTextDisplay exact={selection.exact} />

      {/* Actions */}
      <div className="space-y-2">
        <button
          onClick={handleConvertToReference}
          className={`${buttonStyles.primary.base} w-full justify-center`}
        >
          🔗 Convert to Reference
        </button>

        <button
          onClick={handleDelete}
          className={`${buttonStyles.danger.base} w-full justify-center`}
        >
          🗑️ Delete Highlight
        </button>
      </div>
    </PopupContainer>
  );
}