'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import type { Motivation } from '@semiont/core';
import './AssistSection.css';

interface AssistSectionProps {
  annotationType: 'highlight' | 'assessment' | 'comment';
  isAssisting: boolean;
  progress?: {
    status: string;
    percentage?: number;
    message?: string;
    requestParams?: Array<{ label: string; value: string }>;
  } | null | undefined;
}

// Color schemes are now handled via CSS data attributes

/**
 * Shared assist section for Highlight, Assessment, and Comment panels
 *
 * Provides:
 * - Optional instructions textarea
 * - Optional tone selector (for comments)
 * - Assist button with sparkle animation
 * - Progress display during annotation assist
 *
 * @emits mark:assist-request - Start assist for annotation type. Payload: { motivation: Motivation, options: { instructions?: string, tone?: string, density?: number } }
 * @emits mark:progress-dismiss - Dismiss the annotation progress display
 */
export function AssistSection({
  annotationType,
  isAssisting,
  progress,
}: AssistSectionProps) {

  const panelName = annotationType === 'highlight' ? 'HighlightPanel' :
                     annotationType === 'assessment' ? 'AssessmentPanel' :
                     'CommentsPanel';
  const t = useTranslations(panelName);
  const eventBus = useEventBus();
  const [instructions, setInstructions] = useState('');
  type ToneValue = 'scholarly' | 'explanatory' | 'conversational' | 'technical' | 'analytical' | 'critical' | 'balanced' | 'constructive' | '';
  const [tone, setTone] = useState<ToneValue>('');
  // Default density depends on annotation type
  const defaultDensity = annotationType === 'comment' ? 5 : annotationType === 'assessment' ? 4 : annotationType === 'highlight' ? 5 : 5;
  const [density, setDensity] = useState(defaultDensity);
  const [useDensity, setUseDensity] = useState(true); // Enabled by default

  // Collapsible section state - load from localStorage, default expanded
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem(`assist-section-expanded-${annotationType}`);
    return stored ? stored === 'true' : true;
  });

  // Persist expanded state to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(`assist-section-expanded-${annotationType}`, String(isExpanded));
  }, [isExpanded, annotationType]);

  const handleAssist = useCallback(() => {
    // Map annotation type to motivation
    const motivation: Motivation =
      annotationType === 'highlight' ? 'highlighting' :
      annotationType === 'assessment' ? 'assessing' :
      'commenting';

    // Emit mark:assist-request event with options
    eventBus.get('mark:assist-request').next({
      motivation,
      options: {
        instructions: instructions.trim() || undefined,
        tone: (annotationType === 'comment' || annotationType === 'assessment') && tone ? tone : undefined,
        density: (annotationType === 'comment' || annotationType === 'assessment' || annotationType === 'highlight') && useDensity ? density : undefined,
      },
    });

    setInstructions('');
    setTone('');
    // Don't reset density/useDensity - persist across assists
  }, [annotationType, instructions, tone, useDensity, density]); // eventBus is stable singleton - never in deps

  const handleDismissProgress = useCallback(() => {
    eventBus.get('mark:progress-dismiss').next(undefined);
  }, []); // eventBus is stable singleton - never in deps

  return (
    <div className="semiont-panel__section">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="semiont-panel__section-title semiont-panel__section-title--collapsible"
        aria-expanded={isExpanded}
        type="button"
      >
        <span>
          {t(annotationType === 'highlight' ? 'annotateHighlights' :
             annotationType === 'assessment' ? 'annotateAssessments' :
             'annotateComments')}
        </span>
        <span className="semiont-panel__section-chevron" data-expanded={isExpanded}>
          ›
        </span>
      </button>
      {isExpanded && (
        <div
          className="semiont-assist-widget"
          data-assisting={isAssisting && progress ? 'true' : 'false'}
          data-type={annotationType}
        >
        {/* Show form when NOT assisting and NO progress to display */}
        {!progress && (
          <>
            <div className="semiont-form-field">
              <label className="semiont-form-field__label">
                {t('instructions')} {t('optional')}
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="semiont-textarea"
                rows={3}
                placeholder={t('instructionsPlaceholder')}
                maxLength={500}
              />
              <div className="semiont-form-field__char-count">
                {instructions.length}/500
              </div>
            </div>

            {/* Tone selector - for comments and assessments */}
            {(annotationType === 'comment' || annotationType === 'assessment') && (
              <div className="semiont-form-field">
                <label className="semiont-form-field__label">
                  {t('toneLabel')} {t('toneOptional')}
                </label>
                <select
                  value={tone}
                  onChange={(e) => setTone(e.target.value as ToneValue)}
                  className="semiont-select"
                >
                  <option value="">Default</option>
                  {annotationType === 'comment' && (
                    <>
                      <option value="scholarly">{t('toneScholarly')}</option>
                      <option value="explanatory">{t('toneExplanatory')}</option>
                      <option value="conversational">{t('toneConversational')}</option>
                      <option value="technical">{t('toneTechnical')}</option>
                    </>
                  )}
                  {annotationType === 'assessment' && (
                    <>
                      <option value="analytical">{t('toneAnalytical')}</option>
                      <option value="critical">{t('toneCritical')}</option>
                      <option value="balanced">{t('toneBalanced')}</option>
                      <option value="constructive">{t('toneConstructive')}</option>
                    </>
                  )}
                </select>
              </div>
            )}

            {/* Density selector - for comments, assessments, and highlights */}
            {(annotationType === 'comment' || annotationType === 'assessment' || annotationType === 'highlight') && (
              <div className="semiont-form-field">
                {/* Header with toggle */}
                <div className="semiont-form-field__header">
                  <label className="semiont-form-field__label semiont-form-field__label--with-checkbox">
                    <input
                      type="checkbox"
                      checked={useDensity}
                      onChange={(e) => setUseDensity(e.target.checked)}
                      className="semiont-checkbox"
                      data-variant={annotationType}
                    />
                    <span>{t('densityLabel')}</span>
                  </label>
                  {useDensity && (
                    <span className="semiont-form-field__info">{density} per 2000 words</span>
                  )}
                </div>

                {/* Slider - only shown when enabled */}
                {useDensity && (
                  <>
                    <input
                      type="range"
                      min={annotationType === 'comment' ? '2' : '1'}
                      max={annotationType === 'comment' ? '12' : annotationType === 'assessment' ? '10' : '15'}
                      value={density}
                      onChange={(e) => setDensity(Number(e.target.value))}
                      className="semiont-slider"
                    />
                    <div className="semiont-slider__labels">
                      <span>{t('densitySparse')}</span>
                      <span>{t('densityDense')}</span>
                    </div>
                  </>
                )}
              </div>
            )}

            <button
              onClick={handleAssist}
              className="semiont-button"
              data-variant="assist"
              data-type={annotationType}
            >
              <span className="semiont-button-icon">✨</span>
              <span>{t('annotate')}</span>
            </button>
          </>
        )}

        {/* Annotation Progress - show whenever we have progress (during or after assist) */}
        {progress && (
          <div className="semiont-annotation-progress" data-type={annotationType}>
            {/* Request Parameters */}
            {progress.requestParams && progress.requestParams.length > 0 && (
              <div className="semiont-annotation-progress__params" data-type={annotationType}>
                <div className="semiont-annotation-progress__params-title">Request Parameters:</div>
                {progress.requestParams.map((param, idx) => (
                  <div key={idx} className="semiont-annotation-progress__param">
                    <span className="semiont-annotation-progress__param-label">{param.label}:</span> {param.value}
                  </div>
                ))}
              </div>
            )}

            <div className="semiont-annotation-progress__status">
              <div className="semiont-annotation-progress__message">
                <span className="semiont-annotation-progress__icon">✨</span>
                <span>{progress.message}</span>
              </div>
              {/* Close button - shown after assist completes (when not actively assisting) */}
              {!isAssisting && (
                <button
                  onClick={handleDismissProgress}
                  className="semiont-annotation-progress__close"
                  aria-label={t('closeProgress')}
                  title={t('closeProgress')}
                  type="button"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )}
        </div>
      )}
    </div>
  );
}
