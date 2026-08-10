'use client';

import React, { useEffect, useState } from 'react';
import type { CollaboratorEntry, GatheredContext } from '@semiont/core';
import { LOCALES } from '@semiont/core';

/**
 * Bounds for the max-length control when no ceiling is known. These are the
 * values this control has always shipped — the fallback is today's behaviour,
 * not an unbounded field (INFERENCE-LIMITS-EXPOSURE D6, as corrected in review).
 */
const MIN_MAX_TOKENS = 100;
const DEFAULT_MAX_TOKENS_CEILING = 4000;
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
  defaultTitle: string;
  locale: string;
  context: GatheredContext;
  onBack: () => void;
  onCancel: () => void;
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
    cancel: string;
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
  defaultTitle,
  locale,
  context,
  onBack,
  onCancel,
  onGenerate,
  translations: t,
  generationAgent,
}: ConfigureGenerationStepProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [storagePath, setStoragePath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [language, setLanguage] = useState(locale);
  const [temperature, setTemperature] = useState(0.7);
  // Held as TEXT, not a number, so the field can be cleared while retyping.
  // The old `parseInt(e.target.value)` turned an empty field into NaN, which
  // React warns about and which travelled into the job config.
  const [maxTokensText, setMaxTokensText] = useState('500');

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
    setMaxTokensText((current) => {
      const n = parseInt(current, 10);
      // An empty/mid-edit field is left alone; submission clamps it anyway.
      if (!Number.isFinite(n)) return current;
      return n > ceiling ? String(ceiling) : current;
    });
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
    <form onSubmit={handleSubmit} className="semiont-form semiont-form--scrollable">
      {/* Resource Title */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-title" className="semiont-form__label">
          {t.resourceTitle}
        </label>
        <input
          id="wizard-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
            onChange={(e) => setStoragePath(e.target.value)}
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
          onChange={(e) => setPrompt(e.target.value)}
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
            onChange={(e) => setLanguage(e.target.value)}
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
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
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
              if (raw === '') { setMaxTokensText(''); return; }
              const n = parseInt(raw, 10);
              if (!Number.isFinite(n)) return;
              // `max` alone does not stop a larger value being typed — it only
              // marks the field invalid. D6 says it cannot be entered, so the
              // clamp lives here.
              setMaxTokensText(String(Math.min(n, ceiling)));
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

      {/* Action Buttons */}
      <div className="semiont-modal__actions" style={{ paddingTop: '0.5rem' }}>
        <button
          type="button"
          onClick={onCancel}
          className="semiont-button--secondary semiont-button--flex"
        >
          ✕ {t.cancel}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="semiont-button--secondary semiont-button--flex"
        >
          ◀ {t.back}
        </button>
        <button
          type="submit"
          className="semiont-button--primary semiont-button--flex"
        >
          ✨ {t.generate}
        </button>
      </div>
    </form>
  );
}
