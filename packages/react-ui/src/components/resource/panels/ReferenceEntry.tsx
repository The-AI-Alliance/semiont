'use client';

import type { Ref } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { Annotation } from '@semiont/core';
import { resourceId } from '@semiont/core';
import { getAnnotationExactText, isBodyResolved, getBodySource, getFragmentSelector, getSvgSelector, getTargetSelector } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';
import { getResourceIcon } from '../../../lib/resource-utils';
import type { SemiontSession } from '@semiont/sdk';
import { renderAgentLabel } from './agent-label';
import { useHoverEmitter } from '../../../hooks/useHoverEmitter';

// Extended annotation type with runtime properties added by backend enrichment
interface EnrichedAnnotation extends Annotation {
  _resolvedDocumentName?: string;
  _resolvedDocumentMediaType?: string;
}

interface ReferenceEntryProps {
  /** Session for interaction routing (browse.click etc.); the panel threads it. */
  session: SemiontSession | null;
  reference: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
  /** Host-owned navigation: called with the resolved resource id when the entry's link opens. */
  onOpenResource?: (resourceId: string) => void;
  annotateMode?: boolean;
  isGenerating?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function ReferenceEntry({
  session,
  reference,
  isFocused,
  isHovered = false,
  onOpenResource,
  annotateMode = true,
  isGenerating = false,
  ref,
}: ReferenceEntryProps) {
  const t = useTranslations('ReferencesPanel');
  const semiont = session?.client;
  const hoverProps = useHoverEmitter(session, reference.id);

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
      // resolvedResourceUri is already a bare resource ID
      onOpenResource?.(resolvedResourceUri);
    }
  };

  const source = typeof reference.target === 'object' && 'source' in reference.target
    ? reference.target.source
    : '';

  const handleUnlink = () => {
    if (source && resolvedResourceUri && semiont) {
      semiont.bind.body(
        resourceId(source),
        reference.id,
        [{ op: 'remove', item: { type: 'SpecificResource', source: resolvedResourceUri, purpose: 'linking' } }],
      ).catch(() => { /* error handled by events-stream */ });
    }
  };

  const handleInitiateWizard = () => {
    session?.client.bind.initiate({
      annotationId: reference.id,
      resourceId: resourceId(source),
      defaultTitle: selectedText,
      entityTypes,
    });
  };

  // Status icon click handler depends on state and mode
  const handleIconClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isResolved) {
      handleOpen();
    } else if (annotateMode) {
      handleInitiateWizard();
    }
  };

  const iconIsClickable = isResolved || annotateMode;

  return (
    <div
      ref={ref}
      className={`semiont-annotation-entry${isHovered ? ' semiont-annotation-pulse' : ''}`}
      data-type="reference"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={() => {
        session?.client.browse.click(reference.id, reference.motivation);
      }}
      {...hoverProps}
    >
      {/* Status indicator and text quote */}
      <div className="semiont-annotation-entry__header">
        <div className="semiont-reference-icon-group">
          <button
            className={`semiont-reference-icon${iconIsClickable ? ' semiont-reference-icon--clickable' : ''}`}
            title={isResolved ? t('open') : annotateMode ? t('resolve') : t('stub')}
            onClick={iconIsClickable ? handleIconClick : undefined}
            data-generating={!isResolved && isGenerating ? 'true' : 'false'}
            tabIndex={iconIsClickable ? 0 : -1}
          >
            {isResolved ? '🔗' : '❓'}
          </button>
          {annotateMode && isResolved && (
            <button
              className="semiont-reference-unlink"
              title={t('unlink')}
              onClick={(e) => { e.stopPropagation(); handleUnlink(); }}
            >
              ⛓️‍💥
            </button>
          )}
        </div>
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
      {reference.generator && (
        <div className="semiont-annotation-entry__metadata">
          Via {Array.isArray(reference.generator)
            ? reference.generator.map(renderAgentLabel).join(', ')
            : renderAgentLabel(reference.generator)}
        </div>
      )}
    </div>
  );
}
