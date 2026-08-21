'use client';

import React, { useEffect } from 'react';
import { WizardFooter } from './WizardFooter';
import type { CollaboratorEntry, GatheredContext } from '@semiont/core';
import { LOCALES } from '@semiont/core';

/**
 * Bounds for the max-length control when no ceiling is known. These are the
 * values this control has always shipped — the fallback is today's behaviour,
 * not an unbounded field (INFERENCE-LIMITS-EXPOSURE D6, as corrected in review).
 */
const MIN_MAX_TOKENS = 100;
const DEFAULT_MAX_TOKENS_CEILING = 4000;
/** The step's form values, owned by the wizard so Back cannot discard them (D3). */
export interface GenerationDraft {
  title: string;
  storagePath: string;
  prompt: string;
  language: string;
  temperature: number;
  /** Text, not number: the field is user-editable and may be mid-edit or empty. */
  maxTokensText: string;
}

export interface GenerationConfig {
  title: string;
  storagePath: string;
  prompt?: string;
  language: string;
  temperature: number;
  maxTokens: number;
  context: GatheredContext;
}

export interface ConfigureGenerationStepProps {
  context: GatheredContext;
  /** Echo of the gather step's hint — the thing being steered stays visible (GEP D8). */
  hintEcho?: { label: string; value: string };
  /** Owned by the wizard so Back is lossless (WIZARD-NAVIGATION D3). */
  config: GenerationDraft;
  onConfigChange: (config: GenerationDraft) => void;
  onBack: () => void;
  onGenerate: (config: GenerationConfig) => void;
  translations: {
    resourceTitle: string;
    resourceTitlePlaceholder: string;
    additionalInstructions: string;
    additionalInstructionsPlaceholder: string;
    language: string;
    languageHelp: string;
    creativity: string;
    creativityFocused: string;
    creativityCreative: string;
    maxLength: string;
    maxLengthHelp: string;
    /**
     * Shown INSTEAD of `maxLengthHelp` when the ceiling is known, so the bound
     * is legible rather than mysterious. Interpolates `{{maxOutputTokens}}`
     * and `{{model}}`.
     */
    maxLengthCeiling: string;
    back: string;
    generate: string;
  };
  /**
   * The roster entry serving `generation` (from `useCollaborators`). When its
   * `limits` are known the max-length control is hard-bounded by the model's
   * output ceiling; absent — or present without `limits`, which is normal when
   * discovery could not answer right now — the control keeps its default
   * bounds and generation still submits (D3).
   */
  generationAgent?: CollaboratorEntry;
}

export function ConfigureGenerationStep({
  context,
  hintEcho,
  config,
  onConfigChange,
  onBack,
  onGenerate,
  translations: t,
  generationAgent,
}: ConfigureGenerationStepProps) {
  // CONTROLLED (WIZARD-NAVIGATION D3): these were six local `useState`s, so Back
  // unmounted the step and threw away every typed instruction, the save path and
  // both sliders. `maxTokensText` stays TEXT rather than a number so the field can
  // be cleared mid-edit — `parseInt` on an empty field yields NaN, which React
  // warns about and which used to travel into the job config.
  const { title, storagePath, prompt, language, temperature, maxTokensText } = config;
  const set = (patch: Partial<GenerationDraft>) => onConfigChange({ ...config, ...patch });

  const ceiling = generationAgent?.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS_CEILING;

  /**
   * The value that will actually be submitted: always finite, always inside
   * the bounds, whatever the field currently shows.
   */
  const clamp = (n: number): number =>
    Math.min(Math.max(Number.isFinite(n) ? n : MIN_MAX_TOKENS, MIN_MAX_TOKENS), ceiling);

  const submittedMaxTokens = clamp(parseInt(maxTokensText, 10));

  // Re-clamp whenever the ceiling changes — which INCLUDES its first arrival.
  // `browse.agents()` is asynchronous, so `generationAgent` is undefined on the
  // first render and lands later; clamping only in the `useState` initializer
  // would satisfy a mount-time test and do nothing in the running app.
  useEffect(() => {
    const n = parseInt(maxTokensText, 10);
    // An empty/mid-edit field is left alone; submission clamps it anyway.
    if (Number.isFinite(n) && n > ceiling) set({ maxTokensText: String(ceiling) });
    // `set` and the draft are intentionally out of the dep list: this reacts to the
    // CEILING arriving (browse.agents() is async), not to the user typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceiling]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPrompt = prompt.trim();
    onGenerate({
      title,
      storagePath: `file://${storagePath}`,
      ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
      language,
      temperature,
      maxTokens: submittedMaxTokens,
      context,
    });
  };

  return (
    // No --scrollable: this form renders below the evidence display inside the
    // host's single step-scroll pane — an independent scroll region here is
    // what squeezed the parameters out of view (the measured failure).
    <form onSubmit={handleSubmit} className="semiont-form">
      {hintEcho && (
        <p className="semiont-wizard__hint-echo">
          {hintEcho.label}: {hintEcho.value}
        </p>
      )}
      {/* Resource Title */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-title" className="semiont-form__label">
          {t.resourceTitle}
        </label>
        <input
          id="wizard-title"
          type="text"
          value={title}
          onChange={(e) => set({ title: e.target.value })}
          required
          className="semiont-input"
          placeholder={t.resourceTitlePlaceholder}
        />
      </div>

      {/* Storage URI */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-storagePath" className="semiont-form__label">
          Save location
        </label>
        <div className="semiont-input-addon">
          <span className="semiont-input-addon__prefix">file://</span>
          <input
            id="wizard-storagePath"
            type="text"
            value={storagePath}
            onChange={(e) => set({ storagePath: e.target.value })}
            required
            className="semiont-input semiont-input--addon"
            placeholder="generated/my-resource.md"
          />
        </div>
      </div>

      {/* Additional Instructions */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-prompt" className="semiont-form__label">
          {t.additionalInstructions}
        </label>
        <textarea
          id="wizard-prompt"
          value={prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={2}
          className="semiont-textarea"
          placeholder={t.additionalInstructionsPlaceholder}
        />
      </div>

      {/* Language / Creativity / Max Length — compact inline row */}
      <div className="semiont-form__inline-row">
        <div className="semiont-form__field semiont-form__field--inline">
          <label htmlFor="wizard-language" className="semiont-form__label">
            {t.language}
          </label>
          <select
            id="wizard-language"
            value={language}
            onChange={(e) => set({ language: e.target.value })}
            className="semiont-select"
          >
            {LOCALES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName}
              </option>
            ))}
          </select>
        </div>

        <div className="semiont-form__field semiont-form__field--inline semiont-form__field--grow">
          <label htmlFor="wizard-temperature" className="semiont-form__label">
            {t.creativity} ({temperature.toFixed(1)})
          </label>
          <input
            id="wizard-temperature"
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={temperature}
            onChange={(e) => set({ temperature: parseFloat(e.target.value) })}
            className="semiont-slider"
          />
          <div className="semiont-slider__labels semiont-slider__labels--small">
            <span>{t.creativityFocused}</span>
            <span>{t.creativityCreative}</span>
          </div>
        </div>

        <div className="semiont-form__field semiont-form__field--inline semiont-form__field--narrow">
          <label htmlFor="wizard-maxTokens" className="semiont-form__label">
            {t.maxLength}
          </label>
          <input
            id="wizard-maxTokens"
            type="number"
            min={MIN_MAX_TOKENS}
            max={ceiling}
            step="100"
            value={maxTokensText}
            onChange={(e) => {
              const raw = e.target.value;
              // Empty is a legitimate transient state while retyping.
              if (raw === '') { set({ maxTokensText: '' }); return; }
              const n = parseInt(raw, 10);
              if (!Number.isFinite(n)) return;
              // `max` alone does not stop a larger value being typed — it only
              // marks the field invalid. D6 says it cannot be entered, so the
              // clamp lives here.
              set({ maxTokensText: String(Math.min(n, ceiling)) });
            }}
            className="semiont-input"
          />
          <p className="semiont-form__help">
            {generationAgent?.limits
              ? t.maxLengthCeiling
                  .replace('{{maxOutputTokens}}', String(ceiling))
                  .replace(
                    '{{model}}',
                    (generationAgent.agent as { model?: string; name?: string }).model
                      ?? generationAgent.agent.name,
                  )
              : t.maxLengthHelp}
          </p>
        </div>
      </div>

      <WizardFooter
        backLabel={t.back}
        onBack={onBack}
        primary={{ label: t.generate, type: 'submit' }}
      />
    </form>
  );
}
