'use client';

import { useState, useCallback } from 'react';
import { delegateProgressCopy, delegateSubjectCopy, delegateParamLabel } from '../../../lib/delegate-progress-copy';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { SemiontSession } from '@semiont/sdk';
import type { MarkJobParams, components } from '@semiont/core';
import type { AnnotatorKey } from '../../../lib/annotation-registry';
import { DelegateShell } from './DelegateShell';
import './DelegateSection.css';

type JobProgress = components['schemas']['JobProgress'];

/** The tone a job of `M` takes, as the job's own params type states it. */
type ToneOf<M extends 'commenting' | 'assessing'> = NonNullable<Extract<MarkJobParams, { motivation: M }>['tone']>;

// The tones each menu offers, held to the job they are sent to.
const COMMENT_TONES = ['scholarly', 'explanatory', 'conversational', 'technical'] as const satisfies readonly ToneOf<'commenting'>[];
const ASSESSMENT_TONES = ['analytical', 'critical', 'balanced', 'constructive'] as const satisfies readonly ToneOf<'assessing'>[];

/** `chosen` as one of `tones`, or none when the menu is on its default. */
const toneAmong = <T extends string>(tones: readonly T[], chosen: string): T | undefined =>
  tones.find((tone) => tone === chosen);

/** `Part` itself, held to `Whole`: a member of `Part` that is no member of `Whole` does not compile. */
type Subset<Whole, Part extends Whole> = Part;

interface DelegateSectionProps {
  /** Session carrying the client and event bus; null renders inert. */
  session: SemiontSession | null;
  annotationType: Subset<AnnotatorKey, 'highlight' | 'assessment' | 'comment'>;
  isDelegating: boolean;
  /** User UI locale — written into the annotation body's `language` field for comment/assessment. */
  locale?: string;
  /** BCP-47 tag of the resource being analyzed. Forwarded to the prompt so the LLM analyzes non-English source correctly. */
  sourceLanguage?: string;
  progress?: JobProgress | null | undefined;
}

/**
 * The delegate form for the text motivations (highlight, assessment, comment):
 * instructions, tone (comment/assessment), density — composed into the shared
 * DelegateShell chrome. Reference and tag panels compose the same shell with
 * their own fields (entity chips; schema + categories).
 *
 * @emits mark:delegate-request - Delegate a `mark` job for the annotation type. Payload: { params: MarkJobParams }, the `mark` job's own parameters, its motivation among them
 * @emits mark:progress-dismiss - Dismiss the annotation progress display
 */
export function DelegateSection({
  session,
  annotationType,
  isDelegating,
  locale,
  sourceLanguage,
  progress,
}: DelegateSectionProps) {

  const panelName = annotationType === 'highlight' ? 'HighlightPanel' :
                     annotationType === 'assessment' ? 'AssessmentPanel' :
                     'CommentsPanel';
  const t = useTranslations(panelName);
  const ta = useTranslations('DelegateProgress');
  const [instructions, setInstructions] = useState('');
  const [tone, setTone] = useState('');
  // Default density depends on annotation type
  const defaultDensity = annotationType === 'assessment' ? 4 : 5;
  const [density, setDensity] = useState(defaultDensity);
  const [useDensity, setUseDensity] = useState(true); // Enabled by default

  const handleDelegate = useCallback(() => {
    // What all three jobs take. Source locale applies to all three — it
    // affects analysis quality on non-English source, whether or not a body
    // is produced.
    const shared = {
      instructions: instructions.trim() || undefined,
      density: useDensity ? density : undefined,
      sourceLanguage,
    };
    // Tone and the body locale apply only where the LLM writes
    // natural-language text: a comment and an assessment have a body, a
    // highlight does not, and its job takes neither.
    const params: MarkJobParams =
      annotationType === 'highlight' ? { motivation: 'highlighting', ...shared }
      : annotationType === 'assessment' ? { motivation: 'assessing', ...shared, tone: toneAmong(ASSESSMENT_TONES, tone), language: locale }
      : { motivation: 'commenting', ...shared, tone: toneAmong(COMMENT_TONES, tone), language: locale };

    session?.client.mark.requestDelegate(params);

    setInstructions('');
    setTone('');
    // Don't reset density/useDensity - persist across delegated jobs
  }, [annotationType, instructions, tone, useDensity, density, locale, sourceLanguage, session]);

  const handleDismissProgress = useCallback(() => {
    session?.client.mark.dismissProgress();
  }, [session]);

  return (
    <DelegateShell
      delegateType={annotationType}
      title={t(annotationType === 'highlight' ? 'annotateHighlights' :
               annotationType === 'assessment' ? 'annotateAssessments' :
               'annotateComments')}
      isDelegating={isDelegating}
      progress={progress}
      progressProps={{
        onDismiss: handleDismissProgress,
        translations: {
          cancel: t('cancel'),
          inProgress: t('annotating'),
          close: ta('close'),
          message: delegateProgressCopy(ta),
          subject: delegateSubjectCopy(ta),
          paramLabel: delegateParamLabel(ta),
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

          {/* Density selector — applies to all three motivations */}
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
            onClick={handleDelegate}
            className="semiont-button"
            data-variant="delegate"
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
