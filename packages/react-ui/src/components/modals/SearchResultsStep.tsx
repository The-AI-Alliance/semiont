'use client';

import type { components, GatheredContext } from '@semiont/core';
import { ContextSummary } from './ContextSummary';
import type { ContextSummaryTranslations } from './ContextSummary';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export type ScoredResult = ResourceDescriptor & {
  score?: number;
  matchReason?: string;
};

export interface SearchResultsStepProps {
  results: ScoredResult[];
  context: GatheredContext;
  onLink: (resourceId: string) => void;
  onBack: () => void;
  onCancel: () => void;
  translations: {
    noResults: string;
    link: string;
    back: string;
    cancel: string;
    score: string;
  } & ContextSummaryTranslations;
}

export function SearchResultsStep({
  results,
  context,
  onLink,
  onBack,
  onCancel,
  translations: t,
}: SearchResultsStepProps) {
  return (
    <>
      {/* Two-pane layout: context left, results right */}
      <div className="semiont-search-results__two-pane">
        {/* Left: Gathered Context */}
        <div className="semiont-search-results__context-pane">
          <ContextSummary context={context} translations={t} />
        </div>

        {/* Right: Results List */}
        <div className="semiont-search-results__results-pane">
          {results.length === 0 ? (
            <div className="semiont-modal__empty-state" style={{ textAlign: 'center', padding: '2rem 0' }}>
              {t.noResults}
            </div>
          ) : (
            results.map((result) => {
              const id = result['@id'];
              return (
                <div
                  key={id}
                  style={{
                    padding: '0.75rem',
                    borderBottom: '1px solid var(--semiont-border-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: 'var(--semiont-text-primary)' }}>
                      {result.name}
                    </div>
                    {result.description && (
                      <div style={{
                        fontSize: 'var(--semiont-text-sm)',
                        color: 'var(--semiont-text-secondary)',
                        marginTop: '0.25rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {result.description}
                      </div>
                    )}
                    <div style={{ fontSize: 'var(--semiont-text-xs)', color: 'var(--semiont-text-tertiary)', marginTop: '0.25rem', display: 'flex', gap: '0.5rem' }}>
                      {result.score !== undefined && (
                        <span>{t.score}: {result.score}</span>
                      )}
                      {result.matchReason && (
                        <span>{result.matchReason}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onLink(id)}
                    className="semiont-button--primary"
                    style={{ flexShrink: 0 }}
                  >
                    🔗 {t.link}
                  </button>
                </div>
              );
            })
          )}
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
      </div>
    </>
  );
}
