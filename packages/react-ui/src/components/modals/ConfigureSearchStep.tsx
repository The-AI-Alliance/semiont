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
  onConfigChange: (config: SearchConfig) => void;
  isSearching?: boolean;
  onBack: () => void;
  onSearch: (config: SearchConfig) => void;
  translations: {
    maxResults: string;
    semanticScoring: string;
    semanticScoringHelp: string;
    back: string;
    search: string;
    searching: string;
  };
}

export function ConfigureSearchStep({
  config,
  onConfigChange,
  isSearching = false,
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

      <WizardFooter
        backLabel={t.back}
        onBack={onBack}
        primary={{ label: t.search, pendingLabel: t.searching, pending: isSearching, type: 'submit' }}
      />
    </form>
  );
}
