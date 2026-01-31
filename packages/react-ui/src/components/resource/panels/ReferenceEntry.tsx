'use client';

import React, { useEffect, useRef } from 'react';
import type { RouteBuilder } from '../../../contexts/RoutingContext';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, isBodyResolved, getBodySource } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import { getResourceIcon } from '../../../lib/resource-utils';

type Annotation = components['schemas']['Annotation'];

// Extended annotation type with runtime properties added by backend enrichment
interface EnrichedAnnotation extends Annotation {
  _resolvedDocumentName?: string;
  _resolvedDocumentMediaType?: string;
}

interface ReferenceEntryProps {
  reference: Annotation;
  isFocused: boolean;
  onClick: () => void;
  routes: RouteBuilder;
  onReferenceRef: (referenceId: string, el: HTMLElement | null) => void;
  onReferenceHover?: (referenceId: string | null) => void;
  onGenerateDocument?: (referenceId: string, options: { title: string; prompt?: string }) => void;
  onCreateDocument?: (annotationUri: string, title: string, entityTypes: string[]) => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  onUpdateReference?: (referenceId: string, updates: Partial<Annotation>) => void;
  annotateMode?: boolean;
  isGenerating?: boolean;
}

export function ReferenceEntry({
  reference,
  isFocused,
  onClick,
  routes,
  onReferenceRef,
  onReferenceHover,
  onGenerateDocument,
  onCreateDocument,
  onSearchDocuments,
  onUpdateReference,
  annotateMode = true,
  isGenerating = false,
}: ReferenceEntryProps) {
  const t = useTranslations('ReferencesPanel');
  const referenceRef = useRef<HTMLDivElement>(null);

  // Register ref with parent
  useEffect(() => {
    onReferenceRef(reference.id, referenceRef.current);
    return () => {
      onReferenceRef(reference.id, null);
    };
  }, [reference.id, onReferenceRef]);

  // Scroll to reference when focused - use container.scrollTo to avoid scrolling ancestors
  useEffect(() => {
    if (isFocused && referenceRef.current) {
      const element = referenceRef.current;
      const container = element.closest('.semiont-toolbar-panels__content') as HTMLElement;

      if (container) {
        const elementRect = element.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const isVisible =
          elementRect.top >= containerRect.top &&
          elementRect.bottom <= containerRect.bottom;

        if (!isVisible) {
          const elementTop = element.offsetTop;
          const containerHeight = container.clientHeight;
          const elementHeight = element.offsetHeight;
          const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

          container.scrollTo({ top: scrollTo, behavior: 'smooth' });
        }
      }
    }
  }, [isFocused]);

  const selectedText = getAnnotationExactText(reference) || '';
  const isResolved = isBodyResolved(reference.body);
  const resolvedResourceUri = isResolved ? getBodySource(reference.body) : null;
  const entityTypes = getEntityTypes(reference);

  // Extract resolved document name and media type if enriched by backend
  const enrichedReference = reference as EnrichedAnnotation;
  const resolvedDocumentName = enrichedReference._resolvedDocumentName;
  const resolvedDocumentMediaType = enrichedReference._resolvedDocumentMediaType;
  const resourceIcon = getResourceIcon(resolvedDocumentMediaType);

  const handleOpen = () => {
    if (resolvedResourceUri) {
      const resourceId = resolvedResourceUri.split('/resources/')[1];
      if (resourceId) {
        window.location.href = routes.resourceDetail(resourceId);
      }
    }
  };

  const handleComposeDocument = () => {
    if (onCreateDocument) {
      onCreateDocument(reference.id, selectedText, entityTypes);
    }
  };

  const handleUnlink = () => {
    if (onUpdateReference) {
      onUpdateReference(reference.id, { body: [] });
    }
  };

  const handleGenerate = () => {
    if (onGenerateDocument) {
      onGenerateDocument(reference.id, { title: selectedText });
    }
  };

  const handleSearch = () => {
    if (onSearchDocuments) {
      onSearchDocuments(reference.id, selectedText);
    }
  };

  return (
    <div
      ref={referenceRef}
      className="semiont-annotation-entry"
      data-type="reference"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={onClick}
      onMouseEnter={() => onReferenceHover?.(reference.id)}
      onMouseLeave={() => onReferenceHover?.(null)}
    >
      {/* Status indicator and text quote */}
      <div className="semiont-annotation-entry__header">
        <span className="semiont-reference-icon" title={isResolved ? t('resolved') : t('stub')}>
          {isResolved ? '🔗' : '❓'}
        </span>
        <div className="semiont-annotation-entry__content">
          {selectedText && (
            <div className="semiont-annotation-entry__quote" data-type="reference">
              "{selectedText.substring(0, 100)}{selectedText.length > 100 ? '...' : ''}"
            </div>
          )}
          {!selectedText && (
            <div className="semiont-annotation-entry__meta">
              Image annotation
            </div>
          )}
          {resolvedDocumentName && (
            <div className="semiont-reference-link">
              <span>→ {resourceIcon} {resolvedDocumentName}</span>
            </div>
          )}
        </div>
      </div>

      {/* Entity type badges */}
      {entityTypes.length > 0 && (
        <div className="semiont-annotation-entry__tags">
          {entityTypes.map((type, index) => (
            <span
              key={index}
              className="semiont-tag"
              data-variant="blue"
            >
              {type}
            </span>
          ))}
        </div>
      )}

      {/* Actions based on state - only show curation actions in Annotate mode */}
      <div className="semiont-annotation-entry__actions" onClick={(e) => e.stopPropagation()}>
        {isResolved ? (
          // Resolved reference actions
          <div className="semiont-annotation-entry__action-row">
            <button
              onClick={handleOpen}
              className={`semiont-reference-button semiont-reference-button--primary ${annotateMode ? 'semiont-reference-button--full' : 'semiont-reference-button--wide'}`}
              title={t('open')}
            >
              🔗
            </button>
            {annotateMode && (
              <button
                onClick={handleUnlink}
                className="semiont-reference-button semiont-reference-button--primary"
                title={t('unlink')}
              >
                ⛓️‍💥
              </button>
            )}
          </div>
        ) : (
          // Stub reference actions - only in Annotate mode
          annotateMode && (
            <div className="semiont-annotation-entry__action-row">
              <button
                onClick={handleGenerate}
                className="semiont-reference-button semiont-reference-button--primary semiont-reference-button--full"
                title={t('generate')}
                data-generating={isGenerating ? 'true' : 'false'}
              >
                ✨
              </button>
              <button
                onClick={handleSearch}
                className="semiont-reference-button semiont-reference-button--primary semiont-reference-button--full"
                title={t('find')}
              >
                🔍
              </button>
              <button
                onClick={handleComposeDocument}
                className="semiont-reference-button semiont-reference-button--primary semiont-reference-button--full"
                title={t('create')}
              >
                ✏️
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
