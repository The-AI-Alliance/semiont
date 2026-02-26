'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import type { RouteBuilder, LinkComponentProps } from '../../../contexts/RoutingContext';
import { AnnotateReferencesProgressWidget } from '../../AnnotateReferencesProgressWidget';
import { ReferenceEntry } from './ReferenceEntry';
import type { components, paths, Selector } from '@semiont/core';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { PanelHeader } from './PanelHeader';
import './ReferencesPanel.css';
import type { AnnotationProgress } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type ReferencedBy = ResponseContent<paths['/resources/{id}/referenced-by']['get']>['referencedBy'][number];

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

// Helper to extract display text from selector
function getSelectorDisplayText(selector: Selector | Selector[]): string | null {
  if (Array.isArray(selector)) {
    // Text selectors: array of [TextPositionSelector, TextQuoteSelector]
    const quoteSelector = selector.find(s => s.type === 'TextQuoteSelector');
    if (quoteSelector && 'exact' in quoteSelector) {
      return quoteSelector.exact;
    }
  } else {
    // Single selector
    if (selector.type === 'TextQuoteSelector' && 'exact' in selector) {
      return selector.exact;
    }
  }
  return null;
}

interface Props {
  // Generic panel props
  annotations?: Annotation[];
  isAssisting: boolean;
  progress: AnnotationProgress | null;
  annotateMode?: boolean;
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;

  // Reference-specific props
  allEntityTypes: string[];
  generatingReferenceId?: string | null;
  referencedBy?: ReferencedBy[];
  referencedByLoading?: boolean;
  pendingAnnotation: PendingAnnotation | null;
  scrollToAnnotationId?: string | null;
  onScrollCompleted?: () => void;
  hoveredAnnotationId?: string | null;
}

/**
 * Panel for managing reference annotations with entity type annotation
 *
 * @emits annotate:detect-request - Start reference annotation. Payload: { motivation: 'linking', options: { entityTypes: string[], includeDescriptiveReferences: boolean } }
 * @emits annotate:create - Create new reference annotation. Payload: { motivation: 'linking', selector: Selector | Selector[], body: Body[] }
 * @emits annotate:cancel-pending - Cancel pending reference annotation. Payload: undefined
 * @subscribes attend:click - Annotation clicked. Payload: { annotationId: string }
 */
export function ReferencesPanel({
  annotations = [],
  isAssisting,
  progress,
  annotateMode = true,
  Link,
  routes,
  allEntityTypes,
  generatingReferenceId,
  referencedBy = [],
  referencedByLoading = false,
  pendingAnnotation,
  scrollToAnnotationId,
  onScrollCompleted,
  hoveredAnnotationId,
}: Props) {
  const t = useTranslations('ReferencesPanel');
  const eventBus = useEventBus();
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [lastAnnotationLog, setLastDetectionLog] = useState<Array<{ entityType: string; foundCount: number }> | null>(null);
  const [pendingEntityTypes, setPendingEntityTypes] = useState<string[]>([]);
  const [includeDescriptiveReferences, setIncludeDescriptiveReferences] = useState(false);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Collapsible detection section state - load from localStorage, default expanded
  const [isAssistExpanded, setIsDetectExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('assist-section-expanded-reference');
    return stored ? stored === 'true' : true;
  });

  // Persist detection section expanded state to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('assist-section-expanded-reference', String(isAssistExpanded));
  }, [isAssistExpanded]);

  // Direct ref management - replace useAnnotationPanel hook
  const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Sort annotations by their position in the resource
  const sortedAnnotations = useMemo(() => {
    return [...annotations].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [annotations]);

  // Ref callback for entry components
  const setEntryRef = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) {
      entryRefs.current.set(id, element);
    } else {
      entryRefs.current.delete(id);
    }
  }, []);

  // Handle scrollToAnnotationId (click scroll)
  useEffect(() => {
    if (!scrollToAnnotationId) return;

    const element = entryRefs.current.get(scrollToAnnotationId);

    if (element && containerRef.current) {
      // Calculate scroll position to center element in container
      const elementTop = element.offsetTop;
      const containerHeight = containerRef.current.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

      // Scroll to center
      containerRef.current.scrollTo({ top: scrollTo, behavior: 'smooth' });

      // Add pulse effect
      element.classList.remove('semiont-annotation-pulse');
      void element.offsetWidth; // Force reflow
      element.classList.add('semiont-annotation-pulse');

      // Notify completion
      if (onScrollCompleted) {
        onScrollCompleted();
      }
    } else {
      console.warn('[ReferencesPanel] Element not found for scrollToAnnotationId:', scrollToAnnotationId);
    }
  }, [scrollToAnnotationId]);

  // Handle hoveredAnnotationId (hover scroll only - pulse is handled by isHovered prop)
  useEffect(() => {
    if (!hoveredAnnotationId) return;

    const element = entryRefs.current.get(hoveredAnnotationId);

    if (!element || !containerRef.current) return;

    const container = containerRef.current;
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Only scroll if element is not fully visible
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

    // Pulse effect is handled by isHovered prop on ReferenceEntry
  }, [hoveredAnnotationId]);

  // Subscribe to click events - update focused state
  // Event handler for annotation clicks (extracted to avoid inline arrow function)
  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    setFocusedAnnotationId(annotationId);
    setTimeout(() => setFocusedAnnotationId(null), 3000);
  }, []);

  useEventSubscriptions({
    'attend:click': handleAnnotationClick,
  });

  // Clear log when starting new annotation
  const handleAssist = () => {
    setLastDetectionLog(null);
    eventBus.get('annotate:assist-request').next({
      motivation: 'linking',
      options: {
        entityTypes: selectedEntityTypes,
        includeDescriptiveReferences,
      },
    });
  };

  // Track whether we've already saved the log for the current detection run
  // This prevents infinite loops from repeated state updates
  const hasSavedLogRef = useRef(false);

  // Save detection log when detection completes
  // Only depends on isAssisting boolean to avoid infinite loops from array reference changes
  // Trade-off: If completedEntityTypes changes while isAssisting stays false, we won't update
  // This is acceptable because in practice, completedEntityTypes only changes when annotation finishes
  useEffect(() => {
    // When annotation starts, reset the flag
    if (isAssisting) {
      hasSavedLogRef.current = false;
      return;
    }

    // When annotation is complete and we haven't saved yet, save the log
    if (!isAssisting && !hasSavedLogRef.current && progress?.completedEntityTypes) {
      hasSavedLogRef.current = true;
      setLastDetectionLog(progress.completedEntityTypes);
      setSelectedEntityTypes([]);
    }
  }, [isAssisting, progress?.completedEntityTypes]); // Both dependencies needed to annotation completion

  const togglePendingEntityType = (type: string) => {
    setPendingEntityTypes(prev =>
      prev.includes(type)
        ? prev.filter(t => t !== type)
        : [...prev, type]
    );
  };

  const handleCreateReference = () => {
    if (pendingAnnotation) {
      const entityType = pendingEntityTypes.join(',') || undefined;
      eventBus.get('annotate:create').next({
        motivation: 'linking',
        selector: pendingAnnotation.selector,
        body: entityType ? [{ type: 'TextualBody', value: entityType, purpose: 'tagging' }] : [],
      });
      setPendingEntityTypes([]);
    }
  };

  // Escape key handler for cancelling pending annotation
  useEffect(() => {
    if (!pendingAnnotation) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        eventBus.get('annotate:cancel-pending').next(undefined);
        setPendingEntityTypes([]);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [pendingAnnotation]);

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="reference" count={annotations.length} title={t('title')} />

      {/* New reference creation - shown when there's a pending annotation with linking motivation */}
      {pendingAnnotation && pendingAnnotation.motivation === 'linking' && (
        <div className="semiont-annotation-prompt" data-type="reference">
          <div className="semiont-annotation-prompt__quote">
            {(() => {
              const displayText = getSelectorDisplayText(pendingAnnotation.selector);
              if (displayText) {
                return `"${displayText.substring(0, 100)}${displayText.length > 100 ? '...' : ''}"`;
              }
              // Generic labels for PDF/image annotations without text
              return t('fragmentSelected');
            })()}
          </div>

          {/* Entity Types Multi-Select */}
          {allEntityTypes.length > 0 && (
            <div className="semiont-form-field">
              <p className="semiont-form-field__label">
                {t('entityTypesOptional')}
              </p>
              <div className="semiont-tag-selector">
                {allEntityTypes.map((type: string) => (
                  <button
                    key={type}
                    onClick={() => togglePendingEntityType(type)}
                    className="semiont-tag-selector__item"
                    data-selected={pendingEntityTypes.includes(type) ? 'true' : 'false'}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="semiont-annotation-prompt__footer">
            <div className="semiont-annotation-prompt__actions">
              <button
                onClick={() => {
                  eventBus.get('annotate:cancel-pending').next(undefined);
                  setPendingEntityTypes([]);
                }}
                className="semiont-button semiont-button--secondary"
                data-type="reference"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleCreateReference}
                className="semiont-button semiont-button--primary"
                data-type="reference"
              >
                🔗 {t('createReference')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Assist Section - only in Annotate mode and for text resources */}
        {annotateMode && (
          <div className="semiont-panel__section">
            <button
              onClick={() => setIsDetectExpanded(!isAssistExpanded)}
              className="semiont-panel__section-title semiont-panel__section-title--collapsible"
              aria-expanded={isAssistExpanded}
              type="button"
            >
              <span>{t('annotateReferences')}</span>
              <span className="semiont-panel__section-chevron" data-expanded={isAssistExpanded}>
                ›
              </span>
            </button>
            {isAssistExpanded && (
              <>
                {/* Show annotation UI when not actively assisting */}
                {!isAssisting && (
                <div className="semiont-assist-widget" data-type="reference">
            <>
              {/* Completed annotation log - shown after completion */}
              {lastAnnotationLog && lastAnnotationLog.length > 0 && (
                <div className="semiont-assist-widget__log">
                  <div className="semiont-assist-widget__log-items">
                    {lastAnnotationLog.map((item, index) => (
                      <div key={index} className="semiont-assist-widget__log-item">
                        <span className="semiont-assist-widget__log-check">✓</span>
                        <span className="semiont-assist-widget__log-type">{item.entityType}:</span>
                        <span>{t('found', { count: item.foundCount })}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Entity Types Selection */}
              <div className="semiont-assist-widget__entity-types">
                <p className="semiont-assist-widget__label">
                  {t('selectEntityTypes')}
                </p>
                <div className="semiont-assist-widget__chips">
                  {allEntityTypes.length > 0 ? (
                    allEntityTypes.map((type: string) => (
                      <button
                        key={type}
                        onClick={() => {
                          setSelectedEntityTypes(prev =>
                            prev.includes(type)
                              ? prev.filter(t => t !== type)
                              : [...prev, type]
                          );
                        }}
                        aria-pressed={selectedEntityTypes.includes(type)}
                        aria-label={`${selectedEntityTypes.includes(type) ? t('deselect') : t('select')} ${type}`}
                        className="semiont-chip semiont-chip--selectable"
                        data-selected={selectedEntityTypes.includes(type)}
                      >
                        {type}
                      </button>
                    ))
                  ) : (
                    <p className="semiont-assist-widget__no-types">
                      {t('noEntityTypes')}
                    </p>
                  )}
                </div>
              </div>

              {/* Selected Count */}
              {selectedEntityTypes.length > 0 && (
                <p className="semiont-assist-widget__count">
                  {t('typesSelected', { count: selectedEntityTypes.length })}
                </p>
              )}

              {/* Include Descriptive References Checkbox */}
              <div className="semiont-assist-widget__checkbox-group">
                <label className="semiont-assist-widget__checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeDescriptiveReferences}
                    onChange={(e) => setIncludeDescriptiveReferences(e.target.checked)}
                    className="semiont-assist-widget__checkbox"
                  />
                  <span>{t('includeDescriptiveReferences')}</span>
                </label>
                <p className="semiont-assist-widget__checkbox-hint">
                  {t('descriptiveReferencesTooltip')}
                </p>
              </div>

              {/* Start Assist Button */}
              <button
                onClick={handleAssist}
                disabled={selectedEntityTypes.length === 0}
                title={t('annotate')}
                className="semiont-button"
                data-variant="assist"
                data-type="reference"
              >
                <span className="semiont-button-icon">✨</span>
                <span>{t('annotate')}</span>
              </button>
            </>
            </div>
          )}

          {/* Annotation Progress - shown when active */}
          {isAssisting && progress && (
            <AnnotateReferencesProgressWidget
              progress={progress}
              annotationType="reference"
            />
          )}
              </>
            )}
          </div>
        )}

        {/* References List Section */}
        <div>
          <div className="semiont-panel__divider">
            <h3 className="semiont-panel__subtitle">
              {t('outgoingReferences')} ({sortedAnnotations.length})
            </h3>
          </div>

          <div className="semiont-panel__list">
            {sortedAnnotations.length === 0 ? (
              <p className="semiont-panel__empty-message">
                {t('noReferences')}
              </p>
            ) : (
              sortedAnnotations.map((reference) => (
                <ReferenceEntry
                  key={reference.id}
                  reference={reference}
                  isFocused={reference.id === focusedAnnotationId}
                  isHovered={reference.id === hoveredAnnotationId}
                  routes={routes}
                  annotateMode={annotateMode}
                  isGenerating={reference.id === generatingReferenceId}
                  ref={(el) => setEntryRef(reference.id, el)}
                />
              ))
            )}
          </div>
        </div>

        {/* Referenced By Section */}
        <div>
          <div className="semiont-panel__divider">
            <h3 className="semiont-panel__subtitle">
              {t('incomingReferences')} ({referencedBy.length})
              {referencedByLoading && (
                <span className="semiont-panel__loading-indicator">({t('loading')})</span>
              )}
            </h3>
          </div>

          {referencedBy.length > 0 ? (
            <div className="semiont-panel__list">
              {referencedBy.map((ref) => {
                // Extract resource ID from full URI (e.g., "http://localhost:4000/resources/abc123" -> "abc123")
                const resourceId = ref.target.source.split('/').pop() || '';

                return (
                  <div key={ref.id} className="semiont-reference-item semiont-reference-item--incoming">
                    <div className="semiont-reference-item__header">
                      <span className="semiont-reference-item__title">
                        {ref.resourceName || t('untitledResource')}
                      </span>
                      <Link
                        href={routes.resourceDetail(resourceId)}
                        className="semiont-reference-item__link"
                        title={t('open')}
                      >
                        🔗
                      </Link>
                    </div>
                    <span className="semiont-reference-item__excerpt">
                      "{ref.target.selector?.exact || t('noText')}"
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="semiont-panel__empty-message semiont-panel__empty-message--small">
              {referencedByLoading ? t('loadingEllipsis') : t('noIncomingReferences')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
