'use client';

import React from 'react';
import { CreateAnnotationPopup } from './annotation-popups/CreateAnnotationPopup';
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
  annotation?: Annotation;
  onCreateHighlight?: () => void;
  onCreateReference?: (targetDocId?: string, entityType?: string, referenceType?: string) => void;
  onCreateAssessment?: () => void;
  onCreateComment?: () => void;
  onUpdateAnnotation?: (updates: AnnotationUpdate) => void;
  onDeleteAnnotation?: () => void;
  onGenerateDocument?: (title: string, prompt?: string) => void;
}

type PopupState = 'initial' | 'highlight' | 'assessment' | 'stub_reference' | 'resolved_reference';

export function AnnotationPopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  onCreateHighlight,
  onCreateReference,
  onCreateAssessment,
  onCreateComment,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onGenerateDocument
}: AnnotationPopupProps) {
  // Determine which popup to show
  const getPopupState = (): PopupState => {
    if (!annotation) return 'initial';
    if (isHighlight(annotation)) return 'highlight';
    if (isAssessment(annotation)) return 'assessment';
    if (isReference(annotation)) {
      // Body is either empty array (stub) or SpecificResource with source (resolved)
      // Type assertion needed because TypeScript can't narrow the union properly
      return isBodyResolved((annotation as Annotation).body) ? 'resolved_reference' : 'stub_reference';
    }
    return 'initial';
  };

  const popupState = getPopupState();

  // Don't render anything if not open or no selection
  if (!isOpen || !selection) return null;

  // Render the appropriate popup based on state
  switch (popupState) {
    case 'initial':
      return (
        <CreateAnnotationPopup
          isOpen={isOpen}
          onClose={onClose}
          position={position}
          selection={selection}
          onCreateHighlight={onCreateHighlight!}
          onCreateReference={onCreateReference!}
          onCreateAssessment={onCreateAssessment!}
          {...(onCreateComment && { onCreateComment })}
        />
      );

    case 'highlight':
      // TypeScript doesn't know that annotation is defined and is a highlight when we're in this case
      // We know it's safe because getPopupState() only returns 'highlight' when annotation.type === 'highlight'
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

    case 'assessment':
      // TypeScript doesn't know that annotation is defined and is an assessment when we're in this case
      // We know it's safe because getPopupState() only returns 'assessment' when annotation.motivation === 'assessing'
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

    case 'stub_reference':
      // We know annotation is a reference without body.source
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

    case 'resolved_reference':
      // We know annotation is a reference with body.source
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

    default:
      return null;
  }
}