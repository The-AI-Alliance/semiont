'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { RouteBuilder, LinkComponentProps } from '../../../contexts/RoutingContext';
import { DetectionProgressWidget } from '../../DetectionProgressWidget';
import { ReferenceEntry } from './ReferenceEntry';
import type { components, paths } from '@semiont/api-client';
import { useAnnotationPanel } from '../../../hooks/useAnnotationPanel';
import { PanelHeader } from './PanelHeader';
import { supportsDetection } from '../../../lib/resource-utils';

type Annotation = components['schemas']['Annotation'];
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type ReferencedBy = ResponseContent<paths['/resources/{id}/referenced-by']['get']>['referencedBy'][number];

interface DetectionLog {
  entityType: string;
  foundCount: number;
}

interface Props {
  // Generic panel props
  annotations?: Annotation[];
  onAnnotationClick?: (annotation: Annotation) => void;
  focusedAnnotationId?: string | null;
  hoveredAnnotationId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onDetect: (selectedTypes: string[], includeDescriptiveReferences?: boolean) => void;
  onCreate?: (entityType?: string) => void;
  isDetecting: boolean;
  detectionProgress: any; // TODO: type this properly
  annotateMode?: boolean;
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;

  // Reference-specific props
  allEntityTypes: string[];
  onCancelDetection: () => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  onUpdate?: (referenceId: string, updates: Partial<Annotation>) => void;
  onGenerateDocument?: (referenceId: string, options: { title: string; prompt?: string }) => void;
  mediaType?: string | undefined;
  referencedBy?: ReferencedBy[];
  referencedByLoading?: boolean;
  pendingSelection?: {
    exact: string;
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
    svgSelector?: string;
  } | null;
}

export function ReferencesPanel({
  annotations = [],
  onAnnotationClick,
  focusedAnnotationId,
  hoveredAnnotationId,
  onAnnotationHover,
  onDetect,
  onCreate,
  isDetecting,
  detectionProgress,
  annotateMode = true,
  Link,
  routes,
  allEntityTypes,
  onCancelDetection,
  onSearchDocuments,
  onUpdate,
  onGenerateDocument,
  mediaType,
  referencedBy = [],
  referencedByLoading = false,
  pendingSelection,
}: Props) {
  const t = useTranslations('DetectPanel');
  const tRef = useTranslations('ReferencesPanel');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [lastDetectionLog, setLastDetectionLog] = useState<DetectionLog[] | null>(null);
  const [pendingEntityTypes, setPendingEntityTypes] = useState<string[]>([]);
  const [includeDescriptiveReferences, setIncludeDescriptiveReferences] = useState(false);

  const { sortedAnnotations, containerRef, handleAnnotationRef } =
    useAnnotationPanel(annotations, hoveredAnnotationId);

  // Check if detection is supported for this media type
  const isTextResource = supportsDetection(mediaType);

  // Clear log when starting new detection
  const handleDetect = () => {
    setLastDetectionLog(null);
    onDetect(selectedEntityTypes, includeDescriptiveReferences);
  };

  // Track previous isDetecting state to detect transitions
  const prevIsDetectingRef = useRef(isDetecting);
  const isFirstRenderRef = useRef(true);

  // Save detection log when detection completes
  // Only depends on isDetecting boolean to avoid infinite loops from array reference changes
  // Trade-off: If completedEntityTypes changes while isDetecting stays false, we won't update
  // This is acceptable because in practice, completedEntityTypes only changes when detection finishes
  useEffect(() => {
    const wasDetecting = prevIsDetectingRef.current;
    const isFirstRender = isFirstRenderRef.current;

    prevIsDetectingRef.current = isDetecting;
    isFirstRenderRef.current = false;

    // Save log when:
    // 1. Transitioning from detecting (true) to not detecting (false), OR
    // 2. First render with detection already complete (for tests that start in complete state)
    const shouldSaveLog =
      (wasDetecting && !isDetecting) || // Transition: detection just finished
      (isFirstRender && !isDetecting && detectionProgress?.completedEntityTypes); // Initial: already complete

    if (shouldSaveLog && detectionProgress?.completedEntityTypes) {
      setLastDetectionLog(detectionProgress.completedEntityTypes);
      setSelectedEntityTypes([]);
    }
  }, [isDetecting]); // Intentionally NOT depending on completedEntityTypes array to prevent infinite loops

  const togglePendingEntityType = (type: string) => {
    setPendingEntityTypes(prev =>
      prev.includes(type)
        ? prev.filter(t => t !== type)
        : [...prev, type]
    );
  };

  const handleCreateReference = () => {
    if (onCreate) {
      const entityType = pendingEntityTypes.join(',') || undefined;
      onCreate(entityType);
      setPendingEntityTypes([]);
    }
  };

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="reference" count={annotations.length} title={tRef('referencesTitle')} />

      {/* New reference creation - shown when there's a pending selection */}
      {pendingSelection && onCreate && (
        <div className="semiont-annotation-prompt" data-type="reference">
          <div className="semiont-annotation-prompt__quote">
            {pendingSelection.svgSelector
              ? tRef('imageRegionSelected')
              : `"${pendingSelection.exact.substring(0, 100)}${pendingSelection.exact.length > 100 ? '...' : ''}"`
            }
          </div>

          {/* Entity Types Multi-Select */}
          {allEntityTypes.length > 0 && (
            <div className="semiont-form-field">
              <p className="semiont-form-field__label">
                {tRef('entityTypesOptional')}
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

          <button
            onClick={handleCreateReference}
            className="semiont-button semiont-button--primary"
            data-type="reference"
          >
            🔗 {tRef('createReference')}
          </button>
        </div>
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && isTextResource && (
          <div className="semiont-panel__section">
            <h3 className="semiont-panel__section-title">
              {t('title')}
            </h3>
            {/* Show annotation UI only when not detecting and no completed log */}
            {!detectionProgress && !lastDetectionLog && (
            <div className="semiont-detect-widget" data-type="reference">
            <>
              {/* Entity Types Selection */}
              <div className="semiont-detect-widget__entity-types">
                <p className="semiont-detect-widget__label">
                  {t('selectEntityTypes')}
                </p>
                <div className="semiont-detect-widget__chips">
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
                    <p className="semiont-detect-widget__no-types">
                      {t('noEntityTypes')}
                    </p>
                  )}
                </div>
              </div>

              {/* Selected Count */}
              {selectedEntityTypes.length > 0 && (
                <p className="semiont-detect-widget__count">
                  {t('typesSelected', { count: selectedEntityTypes.length })}
                </p>
              )}

              {/* Include Descriptive References Checkbox */}
              <div className="semiont-detect-widget__checkbox-group">
                <label className="semiont-detect-widget__checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeDescriptiveReferences}
                    onChange={(e) => setIncludeDescriptiveReferences(e.target.checked)}
                    className="semiont-detect-widget__checkbox"
                  />
                  <span>{tRef('includeDescriptiveReferences')}</span>
                </label>
                <p className="semiont-detect-widget__checkbox-hint">
                  {tRef('descriptiveReferencesTooltip')}
                </p>
              </div>

              {/* Start Detection Button */}
              <button
                onClick={handleDetect}
                disabled={selectedEntityTypes.length === 0}
                title={t('startDetection')}
                className="semiont-detect-widget__button"
                data-enabled={selectedEntityTypes.length > 0}
              >
                <span className="semiont-detect-widget__button-icon">✨</span>
              </button>
            </>
            </div>
          )}

          {/* Detection Progress - shown when active */}
          {detectionProgress && (
            <DetectionProgressWidget
              progress={detectionProgress}
              onCancel={onCancelDetection}
            />
          )}

          {/* Completed detection log - shown after completion */}
          {!detectionProgress && lastDetectionLog && lastDetectionLog.length > 0 && (
            <div className="semiont-detect-widget__log">
              <div className="semiont-detect-widget__log-items">
                {lastDetectionLog.map((item, index) => (
                  <div key={index} className="semiont-detect-widget__log-item">
                    <span className="semiont-detect-widget__log-check">✓</span>
                    <span className="semiont-detect-widget__log-type">{item.entityType}:</span>
                    <span>{t('found', { count: item.foundCount })}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setLastDetectionLog(null)}
                className="semiont-detect-widget__button semiont-detect-widget__button--gradient"
              >
                {t('more')}
              </button>
            </div>
          )}
          </div>
        )}

        {/* References List Section */}
        <div>
          <div className="semiont-panel__divider">
            <h3 className="semiont-panel__subtitle">
              {tRef('outgoingReferences')} ({sortedAnnotations.length})
            </h3>
          </div>

          <div className="semiont-panel__list">
            {sortedAnnotations.length === 0 ? (
              <p className="semiont-panel__empty-message">
                {tRef('noReferences')}
              </p>
            ) : (
              sortedAnnotations.map((reference) => (
                <ReferenceEntry
                  key={reference.id}
                  reference={reference}
                  isFocused={reference.id === focusedAnnotationId}
                  onClick={() => onAnnotationClick?.(reference)}
                  routes={routes}
                  onReferenceRef={handleAnnotationRef}
                  annotateMode={annotateMode}
                  {...(onAnnotationHover && { onReferenceHover: onAnnotationHover })}
                  {...(onGenerateDocument && { onGenerateDocument })}
                  {...(onSearchDocuments && { onSearchDocuments })}
                  {...(onUpdate && { onUpdateReference: onUpdate })}
                />
              ))
            )}
          </div>
        </div>

        {/* Referenced By Section */}
        <div>
          <div className="semiont-panel__divider">
            <h3 className="semiont-panel__subtitle">
              {tRef('incomingReferences')} ({referencedBy.length})
              {referencedByLoading && (
                <span className="semiont-panel__loading-indicator">({tRef('loading')})</span>
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
                        {ref.resourceName || tRef('untitledResource')}
                      </span>
                      <Link
                        href={routes.resourceDetail(resourceId)}
                        className="semiont-reference-item__link"
                        title={tRef('open')}
                      >
                        🔗
                      </Link>
                    </div>
                    <span className="semiont-reference-item__excerpt">
                      "{ref.target.selector?.exact || tRef('noText')}"
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="semiont-panel__empty-message semiont-panel__empty-message--small">
              {referencedByLoading ? tRef('loadingEllipsis') : tRef('noIncomingReferences')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
