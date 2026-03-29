'use client';

import { useState, useEffect, useRef } from 'react';
import type { GatheredContext } from '@semiont/core';
import { ContextSummary } from './ContextSummary';
import type { ContextSummaryTranslations } from './ContextSummary';

export interface GatherContextStepProps {
  context: GatheredContext | null;
  contextLoading: boolean;
  contextError: Error | null;
  userHint: string;
  onUserHintChange: (value: string) => void;
  onBind: () => void;
  onGenerate: () => void;
  onCompose: () => void;
  translations: {
    title: string;
    loadingContext: string;
    failedContext: string;
    search: string;
    generate: string;
    compose: string;
    resolutionStrategyLabel: string;
  } & ContextSummaryTranslations;
}

export function GatherContextStep({
  context,
  contextLoading,
  contextError,
  userHint,
  onUserHintChange,
  onBind,
  onGenerate,
  onCompose,
  translations: t,
}: GatherContextStepProps) {
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const contextReady = !contextLoading && !contextError && !!context;
  const sourceContext = context?.sourceContext;
  const highlightRef = useRef<HTMLSpanElement>(null);

  // Scroll the highlighted term into view when context loads
  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [context]);

  return (
    <div className="semiont-gather__outer">
      {/* Loading / error states */}
      {contextLoading && (
        <div className="semiont-gather__loading">
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <span className="semiont-gather__loading-dot" />
            <span className="semiont-gather__loading-dot" />
            <span className="semiont-gather__loading-dot" />
          </div>
          <span className="semiont-gather__loading-text">{t.loadingContext}</span>
        </div>
      )}
      {!!contextError && (
        <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--semiont-color-red-600)' }}>
          {t.failedContext}
        </div>
      )}

      {context && (
        <>
          {/* Full-width source context strip */}
          {sourceContext && (
            <div className="semiont-gather__source-strip">
              <label className="semiont-form__label" style={{ marginBottom: '0.375rem' }}>
                {t.sourceContextLabel}{context.sourceResource?.name ? ` "${context.sourceResource.name}"` : ''}
              </label>
              <div className={`semiont-gather__source-box${sourceExpanded ? ' semiont-gather__source-box--expanded' : ''}`}>
                <div className="semiont-gather__source-context">
                  <div style={{ fontSize: 'var(--semiont-text-sm)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                    {sourceContext.before && <span>{sourceContext.before}</span>}
                    <span
                      ref={highlightRef}
                      style={{
                        backgroundColor: 'var(--semiont-color-primary-100)',
                        padding: '0 0.25rem',
                        fontWeight: 600,
                        color: 'var(--semiont-color-primary-900)',
                      }}
                    >
                      {sourceContext.selected}
                    </span>
                    {(context.metadata?.entityTypes ?? []).map(et => (
                      <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400, verticalAlign: 'middle', marginLeft: '0.25rem' }}>
                        {et}
                      </span>
                    ))}
                    {context.annotation?.motivation && (
                      <span className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400, verticalAlign: 'middle', marginLeft: '0.25rem' }}>
                        {context.annotation.motivation}
                      </span>
                    )}
                    {sourceContext.after && <span>{sourceContext.after}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="semiont-gather__expand-btn"
                  onClick={() => setSourceExpanded(v => !v)}
                >
                  {sourceExpanded ? '▲ less' : '▼ more'}
                </button>
              </div>
            </div>
          )}

          {/* Two-column body */}
          <div className="semiont-gather__body">
            {/* Left: annotation metadata */}
            <div className="semiont-gather__left">
              <ContextSummary context={context} translations={t} />
            </div>

            {/* Right: hint textarea */}
            <div className="semiont-gather__right">
              <div className="semiont-form__field">
                <label className="semiont-form__label">
                  {t.userHintLabel}
                </label>
                <textarea
                  value={userHint}
                  onChange={(e) => onUserHintChange(e.target.value)}
                  placeholder={t.userHintPlaceholder}
                  className="semiont-search-modal__search-input semiont-gather__hint-textarea"
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>
            </div>
          </div>

          {/* Full-width footer: resolution strategy */}
          <div className="semiont-gather__footer">
            <div className="semiont-gather__footer-label">{t.resolutionStrategyLabel}</div>
            <div className="semiont-gather__actions">
              <button
                type="button"
                onClick={onBind}
                disabled={!contextReady}
                className="semiont-button--primary semiont-button--flex"
              >
                🔍 {t.search}…
              </button>
              <button
                type="button"
                onClick={onGenerate}
                disabled={!contextReady}
                className="semiont-button--primary semiont-button--flex"
              >
                ✨ {t.generate}…
              </button>
              <button
                type="button"
                onClick={onCompose}
                disabled={!contextReady}
                className="semiont-button--secondary semiont-button--flex"
              >
                ✍️ {t.compose}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
