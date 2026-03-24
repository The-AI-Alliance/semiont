'use client';

import React, { useState } from 'react';
import type { GatheredContext } from '@semiont/core';
import { LOCALES } from '@semiont/api-client';

export interface GenerationConfig {
  title: string;
  storageUri: string;
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
    cancel: string;
    back: string;
    generate: string;
  };
}

export function ConfigureGenerationStep({
  defaultTitle,
  locale,
  context,
  onBack,
  onCancel,
  onGenerate,
  translations: t,
}: ConfigureGenerationStepProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [storageUri, setStorageUri] = useState('');
  const [prompt, setPrompt] = useState('');
  const [language, setLanguage] = useState(locale);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(500);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPrompt = prompt.trim();
    onGenerate({
      title,
      storageUri,
      ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
      language,
      temperature,
      maxTokens,
      context,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="semiont-form">
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
        <label htmlFor="wizard-storageUri" className="semiont-form__label">
          Save location
        </label>
        <input
          id="wizard-storageUri"
          type="text"
          value={storageUri}
          onChange={(e) => setStorageUri(e.target.value)}
          required
          pattern="file://.+"
          className="semiont-input"
          placeholder="file://generated/my-resource.md"
        />
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
          rows={3}
          className="semiont-textarea"
          placeholder={t.additionalInstructionsPlaceholder}
        />
      </div>

      {/* Language Selection */}
      <div className="semiont-form__field">
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
        <p className="semiont-form__help">
          {t.languageHelp}
        </p>
      </div>

      {/* Temperature Slider */}
      <div className="semiont-form__field">
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
        <div className="semiont-slider__labels">
          <span>{t.creativityFocused}</span>
          <span>{t.creativityCreative}</span>
        </div>
      </div>

      {/* Max Tokens Input */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-maxTokens" className="semiont-form__label">
          {t.maxLength}
        </label>
        <input
          id="wizard-maxTokens"
          type="number"
          min="100"
          max="4000"
          step="100"
          value={maxTokens}
          onChange={(e) => setMaxTokens(parseInt(e.target.value))}
          className="semiont-input"
        />
        <p className="semiont-form__help">
          {t.maxLengthHelp}
        </p>
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
