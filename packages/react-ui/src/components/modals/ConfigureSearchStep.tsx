'use client';

import React, { useState } from 'react';

export interface SearchConfig {
  limit: number;
  useSemanticScoring: boolean;
}

export interface ConfigureSearchStepProps {
  isSearching?: boolean;
  onBack: () => void;
  onCancel: () => void;
  onSearch: (config: SearchConfig) => void;
  translations: {
    maxResults: string;
    semanticScoring: string;
    semanticScoringHelp: string;
    cancel: string;
    back: string;
    search: string;
    searching: string;
  };
}

export function ConfigureSearchStep({
  isSearching = false,
  onBack,
  onCancel,
  onSearch,
  translations: t,
}: ConfigureSearchStepProps) {
  const [limit, setLimit] = useState(10);
  const [useSemanticScoring, setUseSemanticScoring] = useState(true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch({ limit, useSemanticScoring });
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
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value))}
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
        <label className="semiont-form__label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={useSemanticScoring}
            onChange={(e) => setUseSemanticScoring(e.target.checked)}
          />
          {t.semanticScoring}
        </label>
        <p className="semiont-form__help">
          {t.semanticScoringHelp}
        </p>
      </div>

      {/* Action Buttons */}
      <div className="semiont-modal__actions" style={{ paddingTop: '0.5rem' }}>
        <button
          type="button"
          onClick={onCancel}
          className="semiont-button--secondary semiont-button--flex"
          disabled={isSearching}
        >
          ✕ {t.cancel}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="semiont-button--secondary semiont-button--flex"
          disabled={isSearching}
        >
          ◀ {t.back}
        </button>
        <button
          type="submit"
          className="semiont-button--primary semiont-button--flex"
          disabled={isSearching}
          data-generating={isSearching ? 'true' : 'false'}
        >
          {isSearching ? `✨ ${t.searching}` : `🔍 ${t.search}`}
        </button>
      </div>
    </form>
  );
}
