'use client';

import React from 'react';
import { WizardFooter } from './WizardFooter';

export interface SearchConfig {
  limit: number;
  useSemanticScoring: boolean;
}

export interface ConfigureSearchStepProps {
  /**
   * CONTROLLED (WIZARD-NAVIGATION D3). This used to be local `useState`, so stepping
   * Back unmounted the component and silently discarded what the user had chosen —
   * a Back button that costs you work is worse than no Back button, because it
   * invites the press. The wizard owns it for the modal's lifetime instead.
   */
  config: SearchConfig;
  /** Echo of the gather step's hint — the thing being steered stays visible (GEP D8). */
  hintEcho?: { label: string; value: string };
  onConfigChange: (config: SearchConfig) => void;
  isSearching?: boolean;
  /** A settled failure (emit refused, matcher error, timeout) — the spinner
   *  must never outlive the request that fed it. */
  searchError?: string | null;
  onBack: () => void;
  onSearch: (config: SearchConfig) => void;
  translations: {
    maxResults: string;
    semanticScoring: string;
    semanticScoringHelp: string;
    back: string;
    search: string;
    searching: string;
    searchFailed: string;
  };
}

export function ConfigureSearchStep({
  config,
  hintEcho,
  onConfigChange,
  isSearching = false,
  searchError = null,
  onBack,
  onSearch,
  translations: t,
}: ConfigureSearchStepProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(config);
  };

  return (
    <form onSubmit={handleSubmit} className="semiont-form">
      {hintEcho && (
        <p className="semiont-wizard__hint-echo">
          {hintEcho.label}: {hintEcho.value}
        </p>
      )}
      {/* Max Results */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-limit" className="semiont-form__label">
          {t.maxResults}
        </label>
        <select
          id="wizard-limit"
          value={config.limit}
          onChange={(e) => onConfigChange({ ...config, limit: parseInt(e.target.value) })}
          className="semiont-select"
        >
          <option value={1}>1</option>
          <option value={5}>5</option>
          <option value={10}>10</option>
          <option value={20}>20</option>
        </select>
      </div>

      {/* Semantic Scoring Toggle */}
      <div className="semiont-form__field">
        <label className="semiont-form__label semiont-form__label--inline">
          <input
            type="checkbox"
            checked={config.useSemanticScoring}
            onChange={(e) => onConfigChange({ ...config, useSemanticScoring: e.target.checked })}
          />
          {t.semanticScoring}
        </label>
        <p className="semiont-form__help">
          {t.semanticScoringHelp}
        </p>
      </div>

      {searchError && (
        <div role="alert" style={{ textAlign: 'center', padding: '0.5rem 0', color: 'var(--semiont-color-red-600)' }}>
          {t.searchFailed}: {searchError}
        </div>
      )}

      <WizardFooter
        backLabel={t.back}
        onBack={onBack}
        primary={{ label: t.search, pendingLabel: t.searching, pending: isSearching, type: 'submit' }}
      />
    </form>
  );
}
