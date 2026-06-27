'use client';

import React, { useState } from 'react';

export interface ResourceGatherConfig {
  depth: number;
  maxResources: number;
  includeContent: boolean;
  includeSummary: boolean;
}

export interface ConfigureGatherStepProps {
  defaults?: Partial<ResourceGatherConfig>;
  onGather: (config: ResourceGatherConfig) => void;
  onCancel: () => void;
  translations: {
    intro: string;
    includeContent: string;
    includeSummary: string;
    depth: string;
    maxResources: string;
    cancel: string;
    gather: string;
  };
  /** Slot for the exclusion multi-select (GENERATE-FROM-BUTTON Phase 4). */
  children?: React.ReactNode;
}

/**
 * First step of the resource-generate flow: pick the gather options before
 * `gather.resource` runs. The `children` slot hosts the entity-type exclusion
 * multi-select (Phase 4).
 */
export function ConfigureGatherStep({ defaults, onGather, onCancel, translations: t, children }: ConfigureGatherStepProps) {
  const [includeContent, setIncludeContent] = useState(defaults?.includeContent ?? true);
  const [includeSummary, setIncludeSummary] = useState(defaults?.includeSummary ?? true);
  const [depth, setDepth] = useState(defaults?.depth ?? 2);
  const [maxResources, setMaxResources] = useState(defaults?.maxResources ?? 10);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onGather({ includeContent, includeSummary, depth, maxResources });
  };

  return (
    <form onSubmit={handleSubmit} className="semiont-form semiont-form--scrollable">
      <p className="semiont-form__helper-text">{t.intro}</p>

      <div className="semiont-form__checkbox-field">
        <label className="semiont-form__checkbox-label">
          <input type="checkbox" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} />
          {t.includeContent}
        </label>
      </div>
      <div className="semiont-form__checkbox-field">
        <label className="semiont-form__checkbox-label">
          <input type="checkbox" checked={includeSummary} onChange={(e) => setIncludeSummary(e.target.checked)} />
          {t.includeSummary}
        </label>
      </div>

      <div className="semiont-form__inline-row">
        <div className="semiont-form__field semiont-form__field--inline semiont-form__field--narrow">
          <label htmlFor="gather-depth" className="semiont-form__label">{t.depth}</label>
          <input
            id="gather-depth"
            type="number"
            min="1"
            max="5"
            value={depth}
            onChange={(e) => setDepth(parseInt(e.target.value))}
            className="semiont-input"
          />
        </div>
        <div className="semiont-form__field semiont-form__field--inline semiont-form__field--narrow">
          <label htmlFor="gather-max" className="semiont-form__label">{t.maxResources}</label>
          <input
            id="gather-max"
            type="number"
            min="1"
            max="50"
            value={maxResources}
            onChange={(e) => setMaxResources(parseInt(e.target.value))}
            className="semiont-input"
          />
        </div>
      </div>

      {/* Exclusion multi-select slot (Phase 4) */}
      {children}

      <div className="semiont-modal__actions" style={{ paddingTop: '0.5rem' }}>
        <button type="button" onClick={onCancel} className="semiont-button--secondary semiont-button--flex">
          ✕ {t.cancel}
        </button>
        <button type="submit" className="semiont-button--primary semiont-button--flex">
          ✨ {t.gather}
        </button>
      </div>
    </form>
  );
}
