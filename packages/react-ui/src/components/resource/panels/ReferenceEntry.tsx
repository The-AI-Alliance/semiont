'use client';

import type { Ref } from 'react';
import type { RouteBuilder } from '../../../contexts/RoutingContext';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components } from '@semiont/core';
import { annotationId, resourceId } from '@semiont/core';
import { getAnnotationExactText, isBodyResolved, getBodySource, getFragmentSelector, getSvgSelector, getTargetSelector } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import { getResourceIcon } from '../../../lib/resource-utils';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useObservableExternalNavigation } from '../../../hooks/useObservableBrowse';
import { useHoverEmitter } from '../../../hooks/useBeckonFlow';

type Annotation = components['schemas']['Annotation'];

// Extended annotation type with runtime properties added by backend enrichment
interface EnrichedAnnotation extends Annotation {
  _resolvedDocumentName?: string;
  _resolvedDocumentMediaType?: string;
}

interface ReferenceEntryProps {
  reference: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
  routes: RouteBuilder;
  annotateMode?: boolean;
  isGenerating?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function ReferenceEntry({
  reference,
  isFocused,
  isHovered = false,
  routes,
  annotateMode = true,
  isGenerating = false,
  ref,
}: ReferenceEntryProps) {
  const t = useTranslations('ReferencesPanel');
  const eventBus = useEventBus();
  const navigate = useObservableExternalNavigation();
  const hoverProps = useHoverEmitter(reference.id);

  const selectedText = getAnnotationExactText(reference) || '';
  const isResolved = isBodyResolved(reference.body);
  const resolvedResourceUri = isResolved ? getBodySource(reference.body) : null;
  const entityTypes = getEntityTypes(reference);

  // Determine annotation type for non-text annotations
  const selector = getTargetSelector(reference.target);
  const hasFragmentSelector = getFragmentSelector(selector);
  const hasSvgSelector = getSvgSelector(selector);
  const annotationType = hasFragmentSelector ? 'Fragment annotation' : hasSvgSelector ? 'Image annotation' : 'Annotation';

  // Extract resolved document name and media type if enriched by backend
  const enrichedReference = reference as EnrichedAnnotation;
  const resolvedDocumentName = enrichedReference._resolvedDocumentName;
  const resolvedDocumentMediaType = enrichedReference._resolvedDocumentMediaType;
  const resourceIcon = getResourceIcon(resolvedDocumentMediaType);

  const handleOpen = () => {
    if (resolvedResourceUri) {
      const resourceId = resolvedResourceUri.split('/resources/')[1];
      if (resourceId) {
        // Use observable navigation - emits 'browse:external-navigate' event
        navigate(routes.resourceDetail(resourceId), { resourceId });
      }
    }
  };

  const handleComposeDocument = () => {
    eventBus.get('bind:create-manual').next({
      annotationId: annotationId(reference.id),
      title: selectedText,
      entityTypes,
    });
  };

  const handleUnlink = () => {
    // Unlinking removes all body items from the reference annotation
    const sourceUri = typeof reference.target === 'object' && 'source' in reference.target
      ? reference.target.source
      : '';
    const extractedResourceId = sourceUri.split('/resources/')[1] || '';
    if (sourceUri && extractedResourceId) {
      eventBus.get('bind:update-body').next({
        annotationId: annotationId(reference.id),
        resourceId: resourceId(extractedResourceId),
        operations: [{ op: 'remove' }], // Remove all body items
      });
    }
  };

  const sourceUri = typeof reference.target === 'object' && 'source' in reference.target
    ? reference.target.source
    : '';
  const extractedResourceId = sourceUri.split('/resources/')[1] || '';

  const handleGenerate = () => {
    eventBus.get('yield:modal-open').next({
      annotationId: annotationId(reference.id),
      resourceId: resourceId(extractedResourceId),
      defaultTitle: selectedText,
    });
  };

  const handleSearch = () => {
    eventBus.get('bind:link').next({
      annotationId: annotationId(reference.id),
      resourceId: resourceId(extractedResourceId),
      searchTerm: selectedText,
    });
  };

  return (
    <div
      ref={ref}
      className={`semiont-annotation-entry${isHovered ? ' semiont-annotation-pulse' : ''}`}
      data-type="reference"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={() => {
        eventBus.get('browse:click').next({ annotationId: reference.id, motivation: reference.motivation });
      }}
      {...hoverProps}
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
              {annotationType}
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
