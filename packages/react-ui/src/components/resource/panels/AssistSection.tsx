'use client';

import { useState, useCallback } from 'react';
import { assistProgressTranslations } from '../../../lib/assist-progress-copy';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { SemiontSession } from '@semiont/sdk';
import type { Motivation, components } from '@semiont/core';
import { AssistShell } from './AssistShell';
import './AssistSection.css';

type JobProgress = components['schemas']['JobProgress'];

interface AssistSectionProps {
  /** Session carrying the client and event bus; null renders inert. */
  session: SemiontSession | null;
  annotationType: 'highlight' | 'assessment' | 'comment';
  isAssisting: boolean;
  /** User UI locale — written into the annotation body's `language` field for comment/assessment. */
  locale?: string;
  /** BCP-47 tag of the resource being analyzed. Forwarded to the prompt so the LLM analyzes non-English source correctly. */
  sourceLanguage?: string;
  progress?: JobProgress | null | undefined;
}

/**
 * Assist fields for the text motivations (highlight, assessment, comment):
 * instructions, tone (comment/assessment), density — composed into the shared
 * AssistShell chrome. Reference and tag panels compose the same shell with
 * their own fields (entity chips; schema + categories).
 *
 * @emits mark:assist-request - Start assist for annotation type. Payload: { motivation: Motivation, options: { instructions?: string, tone?: string, density?: number } }
 * @emits mark:progress-dismiss - Dismiss the annotation progress display
 */
export function AssistSection({
  session,
  annotationType,
  isAssisting,
  locale,
  sourceLanguage,
  progress,
}: AssistSectionProps) {

  const panelName = annotationType === 'highlight' ? 'HighlightPanel' :
                     annotationType === 'assessment' ? 'AssessmentPanel' :
                     'CommentsPanel';
  const t = useTranslations(panelName);
  const ta = useTranslations('AssistProgress');
  const [instructions, setInstructions] = useState('');
  type ToneValue = 'scholarly' | 'explanatory' | 'conversational' | 'technical' | 'analytical' | 'critical' | 'balanced' | 'constructive' | '';
  const [tone, setTone] = useState<ToneValue>('');
  // Default density depends on annotation type
  const defaultDensity = annotationType === 'assessment' ? 4 : 5;
  const [density, setDensity] = useState(defaultDensity);
  const [useDensity, setUseDensity] = useState(true); // Enabled by default

  const handleAssist = useCallback(() => {
    // Map annotation type to motivation
    const motivation: Motivation =
      annotationType === 'highlight' ? 'highlighting' :
      annotationType === 'assessment' ? 'assessing' :
      'commenting';

    session?.client.mark.requestAssist(motivation, {
      instructions: instructions.trim() || undefined,
      tone: (annotationType === 'comment' || annotationType === 'assessment') && tone ? tone : undefined,
      density: useDensity ? density : undefined,
      // Body locale only applies where the LLM writes natural-language text:
      // comment/assessment have a body, highlight does not.
      language: (annotationType === 'comment' || annotationType === 'assessment') ? locale : undefined,
      // Source locale applies to all three — affects analysis quality on
      // non-English source, regardless of whether a body is produced.
      sourceLanguage,
    });

    setInstructions('');
    setTone('');
    // Don't reset density/useDensity - persist across assists
  }, [annotationType, instructions, tone, useDensity, density, locale, sourceLanguage, session]);

  const handleDismissProgress = useCallback(() => {
    session?.client.mark.dismissProgress();
  }, [session]);

  return (
    <AssistShell
      assistType={annotationType}
      title={t(annotationType === 'highlight' ? 'annotateHighlights' :
               annotationType === 'assessment' ? 'annotateAssessments' :
               'annotateComments')}
      isAssisting={isAssisting}
      progress={progress}
      progressProps={{
        onDismiss: handleDismissProgress,
        translations: {
          cancel: t('cancel'),
          inProgress: t('annotating'),
          close: ta('close'),
          message: assistProgressCopy(ta),
          subject: assistSubjectCopy(ta),
          paramLabel: assistParamLabel(ta),
        },
      }}
      form={
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

          {/* Density selector — applies to every assist type */}
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
                <span className="semiont-form-field__info">{t('densityPerWords', { density })}</span>
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
      }
    />
  );
}
