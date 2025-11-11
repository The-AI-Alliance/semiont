'use client';

import React from 'react';
import { HighlightPopup } from './annotation-popups/HighlightPopup';
import { AssessmentPopup } from './annotation-popups/AssessmentPopup';
import { StubReferencePopup } from './annotation-popups/StubReferencePopup';
import { ResolvedReferencePopup } from './annotation-popups/ResolvedReferencePopup';
import type { components } from '@semiont/api-client';
import { isHighlight, isReference, isAssessment, isBodyResolved } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type HighlightAnnotation = components['schemas']['Annotation'];
type ReferenceAnnotation = components['schemas']['Annotation'];
type AnnotationUpdate = Partial<components['schemas']['Annotation']>;
type TextSelection = { exact: string; start: number; end: number };

interface AnnotationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: TextSelection | null;
  annotation: Annotation;
  onUpdateAnnotation?: (updates: AnnotationUpdate) => void;
  onDeleteAnnotation?: () => void;
  onGenerateDocument?: (title: string, prompt?: string) => void;
}

export function AnnotationPopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onGenerateDocument
}: AnnotationPopupProps) {
  // Don't render anything if not open or no selection
  if (!isOpen || !selection) return null;

  // Determine which popup to show based on annotation type
  if (isHighlight(annotation)) {
    return (
      <HighlightPopup
        isOpen={isOpen}
        onClose={onClose}
        position={position}
        selection={selection}
        annotation={annotation as HighlightAnnotation}
        onDeleteAnnotation={onDeleteAnnotation!}
      />
    );
  }

  if (isAssessment(annotation)) {
    return (
      <AssessmentPopup
        isOpen={isOpen}
        onClose={onClose}
        position={position}
        selection={selection}
        annotation={annotation as Annotation}
        onUpdateAnnotation={onUpdateAnnotation!}
        onDeleteAnnotation={onDeleteAnnotation!}
      />
    );
  }

  if (isReference(annotation)) {
    const isResolved = isBodyResolved((annotation as Annotation).body);

    if (isResolved) {
      return (
        <ResolvedReferencePopup
          isOpen={isOpen}
          onClose={onClose}
          position={position}
          selection={selection}
          annotation={annotation as ReferenceAnnotation}
          onUpdateAnnotation={onUpdateAnnotation!}
          onDeleteAnnotation={onDeleteAnnotation!}
        />
      );
    } else {
      return (
        <StubReferencePopup
          isOpen={isOpen}
          onClose={onClose}
          position={position}
          selection={selection}
          annotation={annotation as ReferenceAnnotation}
          onUpdateAnnotation={onUpdateAnnotation!}
          onDeleteAnnotation={onDeleteAnnotation!}
          onGenerateDocument={onGenerateDocument!}
        />
      );
    }
  }

  // Unknown annotation type - return null
  return null;
}