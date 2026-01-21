'use client';

import React, { useState } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { ANNOTATORS } from '../../../lib/annotation-registry';

interface DetectSectionProps {
  annotationType: 'highlight' | 'assessment' | 'comment';
  isDetecting: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
    requestParams?: Array<{ label: string; value: string }>;
  } | null | undefined;
  onDetect: (instructions?: string, tone?: string, density?: number) => void | Promise<void>;
}

// Color schemes are now handled via CSS data attributes

/**
 * Shared detect section for Highlight, Assessment, and Comment panels
 *
 * Provides:
 * - Optional instructions textarea
 * - Optional tone selector (for comments)
 * - Detect button with sparkle animation
 * - Progress display during detection
 */
export function DetectSection({
  annotationType,
  isDetecting,
  detectionProgress,
  onDetect
}: DetectSectionProps) {
  const panelName = annotationType === 'highlight' ? 'HighlightPanel' :
                     annotationType === 'assessment' ? 'AssessmentPanel' :
                     'CommentsPanel';
  const t = useTranslations(panelName);
  const [instructions, setInstructions] = useState('');
  const [tone, setTone] = useState('');
  // Default density depends on annotation type
  const defaultDensity = annotationType === 'comment' ? 5 : annotationType === 'assessment' ? 4 : annotationType === 'highlight' ? 5 : 5;
  const [density, setDensity] = useState(defaultDensity);
  const [useDensity, setUseDensity] = useState(true); // Enabled by default
  const metadata = ANNOTATORS[annotationType]!;

  const handleDetect = () => {
    onDetect(
      instructions.trim() || undefined,
      (annotationType === 'comment' || annotationType === 'assessment') && tone ? tone : undefined,
      (annotationType === 'comment' || annotationType === 'assessment' || annotationType === 'highlight') && useDensity ? density : undefined
    );
    setInstructions('');
    setTone('');
    // Don't reset density/useDensity - persist across detections
  };

  return (
    <div className="semiont-panel__section">
      <h3 className="semiont-panel__section-title">
        {t(annotationType === 'highlight' ? 'detectHighlights' :
           annotationType === 'assessment' ? 'detectAssessments' :
           'detectComments')}
      </h3>
      <div
        className="semiont-detect-widget"
        data-detecting={isDetecting && detectionProgress ? 'true' : 'false'}
        data-type={annotationType}
      >
        {!isDetecting && !detectionProgress && (
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
                  onChange={(e) => setTone(e.target.value)}
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
              onClick={handleDetect}
              className="semiont-button"
              data-variant="detect"
              data-type={annotationType}
            >
              <span className="semiont-button-icon">✨</span>
              <span>{t('detect')}</span>
            </button>
          </>
        )}

        {/* Detection Progress */}
        {isDetecting && detectionProgress && (
          <div className="semiont-detection-progress">
            {/* Request Parameters */}
            {detectionProgress.requestParams && detectionProgress.requestParams.length > 0 && (
              <div className="semiont-detection-progress__params" data-type={annotationType}>
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
