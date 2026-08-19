'use client';

import type { GatheredContext } from '@semiont/core';

export interface CorpusPaneTranslations {
  corpusPaneTitle: string;
  /** Strategy-relevant empty state — emptiness is evidence (GEP D1). */
  corpusEmpty: string;
  /** Label for the match's cosine score. */
  score: string;
  /** The filter receipt; interpolates `{{types}}`. */
  excludedReceipt: string;
  /** The trust marker for machine-read (OCR) sources. */
  machineRead: string;
}

export interface CorpusPaneProps {
  semanticContext: GatheredContext['semanticContext'];
  translations: CorpusPaneTranslations;
}

/**
 * The corpus pane (GEP D4): latent knowledge — ranked `SemanticMatch` cards,
 * read-only. THE datum for Search-vs-Generate ("does the KB already discuss
 * this?"). This is recall-at-gather evidence, not a preview of Search: the
 * matcher re-runs fresh (selected text + hint, scoring) and may rank
 * differently.
 *
 * Read-only for now by decision, not forever — when per-match actions arrive
 * they route through the footer's fork or a designed extension of it, never
 * ad-hoc buttons here.
 */
export function CorpusPane({ semanticContext, translations: t }: CorpusPaneProps) {
  // Descending by score, whatever order the wire delivered.
  const matches = [...(semanticContext?.similar ?? [])].sort((a, b) => b.score - a.score);
  const excluded = semanticContext?.excludedEntityTypes ?? [];

  return (
    <div className="semiont-gather-pane semiont-gather-pane--corpus">
      <div className="semiont-gather-pane__title">{t.corpusPaneTitle}</div>
      {matches.length === 0 ? (
        <p className="semiont-gather-pane__empty">{t.corpusEmpty}</p>
      ) : (
        <ul className="semiont-corpus__list">
          {matches.map((m, i) => (
            <li key={`${m.resourceId}-${i}`} className="semiont-corpus__card">
              <div className="semiont-corpus__card-head">
                <span className="semiont-corpus__source">{m.resourceName}</span>
                {(m.entityTypes ?? []).map((et) => (
                  <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400 }}>
                    {et}
                  </span>
                ))}
                {m.machineRead && (
                  <span className="semiont-chip semiont-corpus__trust" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400 }}>
                    {t.machineRead}
                  </span>
                )}
                {/* 0–1 cosine to two places — deliberately NOT the search step's
                    raw render, which is a different scale (logged deviation). */}
                <span className="semiont-corpus__score">{t.score}: {m.score.toFixed(2)}</span>
              </div>
              <p className="semiont-corpus__snippet">{m.text}</p>
            </li>
          ))}
        </ul>
      )}
      {excluded.length > 0 && (
        <p className="semiont-corpus__receipt">
          {t.excludedReceipt.replace('{{types}}', excluded.join(', '))}
        </p>
      )}
    </div>
  );
}
