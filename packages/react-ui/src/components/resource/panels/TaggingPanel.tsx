'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import type { components, Selector } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { TagEntry } from './TagEntry';
import { PanelHeader } from './PanelHeader';
import { getAllTagSchemas } from '../../../lib/tag-schemas';
import './TaggingPanel.css';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

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

interface TaggingPanelProps {
  annotations: Annotation[];
  annotateMode?: boolean;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    currentCategory?: string;
    processedCategories?: number;
    totalCategories?: number;
    message?: string;
    requestParams?: Array<{ label: string; value: string }>;
  } | null;
  pendingAnnotation: PendingAnnotation | null;
  scrollToAnnotationId?: string | null;
  onScrollCompleted?: () => void;
  hoveredAnnotationId?: string | null;
}

export function TaggingPanel({
  annotations,
  annotateMode = true,
  isDetecting = false,
  detectionProgress,
  pendingAnnotation,
  scrollToAnnotationId,
  onScrollCompleted,
  hoveredAnnotationId,
}: TaggingPanelProps) {
  const t = useTranslations('TaggingPanel');
  const eventBus = useEventBus();
  const [selectedSchemaId, setSelectedSchemaId] = useState<string>('legal-irac');
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Collapsible detection section state - load from localStorage, default expanded
  const [isDetectExpanded, setIsDetectExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('detect-section-expanded-tag');
    return stored ? stored === 'true' : true;
  });

  // Persist detection section expanded state to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('detect-section-expanded-tag', String(isDetectExpanded));
  }, [isDetectExpanded]);

  // Subscribe to click events - update focused state
  // Event handler for annotation clicks (extracted to avoid inline arrow function)
  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    setFocusedAnnotationId(annotationId);
    setTimeout(() => setFocusedAnnotationId(null), 3000);
  }, []);

  useEventSubscriptions({
    'annotation:click': handleAnnotationClick,
  });

  // Direct ref management
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
      const elementTop = element.offsetTop;
      const containerHeight = containerRef.current.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);
      containerRef.current.scrollTo({ top: scrollTo, behavior: 'smooth' });
      element.classList.remove('semiont-annotation-pulse');
      void element.offsetWidth;
      element.classList.add('semiont-annotation-pulse');
      if (onScrollCompleted) onScrollCompleted();
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
    const isVisible = elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom;
    if (!isVisible) {
      const elementTop = element.offsetTop;
      const containerHeight = container.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);
      container.scrollTo({ top: scrollTo, behavior: 'smooth' });
    }

    // Pulse effect is handled by isHovered prop on TagEntry
  }, [hoveredAnnotationId]);

  const schemas = getAllTagSchemas();
  const selectedSchema = schemas.find(s => s.id === selectedSchemaId);

  const handleSchemaChange = (schemaId: string) => {
    setSelectedSchemaId(schemaId);
    setSelectedCategories(new Set()); // Reset categories when schema changes
  };

  const handleCategoryToggle = (category: string) => {
    const newCategories = new Set(selectedCategories);
    if (newCategories.has(category)) {
      newCategories.delete(category);
    } else {
      newCategories.add(category);
    }
    setSelectedCategories(newCategories);
  };

  const handleSelectAll = () => {
    if (selectedSchema) {
      setSelectedCategories(new Set(selectedSchema.tags.map(t => t.name)));
    }
  };

  const handleDeselectAll = () => {
    setSelectedCategories(new Set());
  };

  const handleDetect = () => {
    if (selectedCategories.size > 0) {
      eventBus.emit('detection:start', {
        motivation: 'tagging',
        options: {
          schemaId: selectedSchemaId,
          categories: Array.from(selectedCategories),
        },
      });
      setSelectedCategories(new Set()); // Reset after detection
    }
  };

  // Escape key handler for cancelling pending annotation
  useEffect(() => {
    if (!pendingAnnotation) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        eventBus.emit('annotation:cancel-pending', undefined);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [pendingAnnotation]);

  // Color schemes are now handled via CSS data attributes

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="tag" count={annotations.length} title={t('title')} />

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Pending Manual Tag Creation - shown when there's a pending annotation with tagging motivation */}
        {pendingAnnotation && pendingAnnotation.motivation === 'tagging' && (
          <div className="semiont-annotation-prompt" data-type="tag">
            <h3 className="semiont-annotation-prompt__title">
              {t('createTagForSelection')}
            </h3>
            <div className="semiont-annotation-prompt__quote">
              <p className="semiont-annotation-prompt__text">
                {(() => {
                  const displayText = getSelectorDisplayText(pendingAnnotation.selector);
                  if (displayText) {
                    return `"${displayText.substring(0, 100)}${displayText.length > 100 ? '...' : ''}"`;
                  }
                  // Generic labels for PDF/image annotations without text
                  return t('fragmentSelected');
                })()}
              </p>
            </div>

            {/* Schema and Category Selection for Manual Tag */}
            <div className="semiont-form-field">
              <label className="semiont-form-field__label">
                {t('selectSchema')}
              </label>
              <select
                value={selectedSchemaId}
                onChange={(e) => handleSchemaChange(e.target.value)}
                className="semiont-select"
              >
                {schemas.map(schema => (
                  <option key={schema.id} value={schema.id}>
                    {t(`schema${schema.id === 'legal-irac' ? 'Legal' : schema.id === 'scientific-imrad' ? 'Scientific' : 'Argument'}`)}
                  </option>
                ))}
              </select>
            </div>

            {selectedSchema && (
              <div className="semiont-form-field">
                <label className="semiont-form-field__label">
                  {t('selectCategory')}
                </label>
                <select
                  className="semiont-select"
                  onChange={(e) => {
                    if (e.target.value && pendingAnnotation) {
                      eventBus.emit('annotation:create', {
                        motivation: 'tagging',
                        selector: pendingAnnotation.selector,
                        body: [
                          {
                            type: 'TextualBody',
                            value: e.target.value,
                            purpose: 'tagging',
                            schema: selectedSchemaId,
                          },
                        ],
                      });
                    }
                  }}
                  defaultValue=""
                >
                  <option value="">{t('chooseCategory')}</option>
                  {selectedSchema.tags.map((tag) => (
                    <option key={tag.name} value={tag.name}>{tag.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Cancel button */}
            <div className="semiont-annotation-prompt__footer">
              <button
                onClick={() => eventBus.emit('annotation:cancel-pending', undefined)}
                className="semiont-button semiont-button--secondary"
                data-type="tag"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Detection Section - only in Annotate mode */}
        {annotateMode && (
          <div className="semiont-panel__section">
            <button
              onClick={() => setIsDetectExpanded(!isDetectExpanded)}
              className="semiont-panel__section-title semiont-panel__section-title--collapsible"
              aria-expanded={isDetectExpanded}
              type="button"
            >
              <span>{t('detectTags')}</span>
              <span className="semiont-panel__section-chevron" data-expanded={isDetectExpanded}>
                ›
              </span>
            </button>
            {isDetectExpanded && (
              <div className="semiont-detect-widget" data-detecting={isDetecting && detectionProgress ? 'true' : 'false'} data-type="tag">
              {!isDetecting && !detectionProgress && (
                <>
                  {/* Schema Selector */}
                  <div className="semiont-form-field">
                    <label className="semiont-form-field__label">
                      {t('selectSchema')}
                    </label>
                    <select
                      value={selectedSchemaId}
                      onChange={(e) => handleSchemaChange(e.target.value)}
                      className="semiont-select"
                    >
                      {schemas.map(schema => (
                        <option key={schema.id} value={schema.id}>
                          {t(`schema${schema.id === 'legal-irac' ? 'Legal' : schema.id === 'scientific-imrad' ? 'Scientific' : 'Argument'}`)}
                        </option>
                      ))}
                    </select>
                    {selectedSchema && (
                      <p className="semiont-form__help">
                        {selectedSchema.description}
                      </p>
                    )}
                  </div>

                  {/* Category Selector */}
                  {selectedSchema && (
                    <div className="semiont-form-field">
                      <label className="semiont-form-field__label">
                        {t('selectCategories')}
                      </label>
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <button
                          onClick={handleSelectAll}
                          type="button"
                          className="semiont-button--secondary"
                          style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.25rem 0.5rem' }}
                        >
                          {t('selectAll')}
                        </button>
                        <button
                          onClick={handleDeselectAll}
                          type="button"
                          className="semiont-button--secondary"
                          style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.25rem 0.5rem' }}
                        >
                          {t('deselectAll')}
                        </button>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {selectedSchema.tags.map(category => (
                          <div key={category.name} className="semiont-form__checkbox-field">
                            <input
                              type="checkbox"
                              id={`category-${category.name.replace(/\s+/g, '-')}`}
                              checked={selectedCategories.has(category.name)}
                              onChange={() => handleCategoryToggle(category.name)}
                              className="semiont-checkbox"
                            />
                            <label
                              htmlFor={`category-${category.name.replace(/\s+/g, '-')}`}
                              className="semiont-form__checkbox-label"
                              style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
                            >
                              <span style={{ fontWeight: 500 }}>
                                {t(`category${category.name.replace(/\s+/g, '')}`)}
                              </span>
                              <span style={{ fontSize: 'var(--semiont-text-xs)', color: 'var(--semiont-text-secondary)' }}>
                                {category.description}
                              </span>
                            </label>
                          </div>
                        ))}
                      </div>

                      <p className="semiont-form__help">
                        {t('categoriesSelected', { count: selectedCategories.size })}
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* Detect Button - Always visible */}
              <button
                onClick={handleDetect}
                disabled={selectedCategories.size === 0 || isDetecting}
                className="semiont-button"
                data-variant="detect"
                data-type="tag"
              >
                <span className="semiont-button-icon">✨</span>
                <span>{t('detect')}</span>
              </button>

              {/* Detection Progress */}
              {isDetecting && detectionProgress && (
                <div className="semiont-detection-progress" data-type="tag">
                  {/* Request Parameters */}
                  {detectionProgress.requestParams && detectionProgress.requestParams.length > 0 && (
                    <div className="semiont-detection-progress__params" data-type="tag">
                      <div className="semiont-detection-progress__params-title">Request Parameters:</div>
                      {detectionProgress.requestParams.map((param, idx) => (
                        <div key={idx} className="semiont-detection-progress__param">
                          <span className="semiont-detection-progress__param-label">{param.label}:</span> {param.value}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="semiont-detection-progress__status">
                    <div className="semiont-detection-progress__message">
                      <span className="semiont-detection-progress__icon">✨</span>
                      <span>{detectionProgress.message}</span>
                    </div>
                    {detectionProgress.currentCategory && (
                      <div className="semiont-detection-progress__details">
                        Processing: {detectionProgress.currentCategory}
                        {detectionProgress.processedCategories !== undefined && detectionProgress.totalCategories !== undefined && (
                          <> ({detectionProgress.processedCategories}/{detectionProgress.totalCategories})</>
                        )}
                      </div>
                    )}
                  </div>
                  {detectionProgress.percentage !== undefined && (
                    <div className="semiont-progress-bar">
                      <div
                        className="semiont-progress-bar__fill"
                        data-type="tag"
                        style={{ width: `${detectionProgress.percentage}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
              </div>
            )}
          </div>
        )}

        {/* Tags list */}
        <div className="semiont-panel__list">
          {sortedAnnotations.length === 0 ? (
            <p className="semiont-panel__empty">
              {t('noTags')}
            </p>
          ) : (
            sortedAnnotations.map((tag) => (
              <TagEntry
                key={tag.id}
                tag={tag}
                isFocused={tag.id === focusedAnnotationId}
                isHovered={tag.id === hoveredAnnotationId}
                ref={(el) => setEntryRef(tag.id, el)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
