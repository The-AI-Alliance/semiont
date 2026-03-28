'use client';

import { useState } from 'react';
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
              <label className="semiont-form__label" style={{ marginBottom: '0.375rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.375rem' }}>
                <span>{t.sourceContextLabel}</span>
                {context.sourceResource?.name && (
                  <span style={{ fontWeight: 400, color: 'var(--semiont-text-primary)' }}>
                    — {context.sourceResource.name}
                  </span>
                )}
                {sourceContext.selected && (
                  <span style={{
                    fontWeight: 600,
                    color: 'var(--semiont-color-primary-700)',
                    backgroundColor: 'var(--semiont-color-primary-100)',
                    padding: '0.125rem 0.375rem',
                    borderRadius: '0.25rem',
                    fontFamily: 'monospace',
                    fontSize: 'var(--semiont-text-sm)',
                  }}>
                    "{sourceContext.selected}"
                  </span>
                )}
                {(context.metadata?.entityTypes ?? []).map(et => (
                  <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem', fontWeight: 400 }}>
                    {et}
                  </span>
                ))}
                {context.annotation?.motivation && (
                  <span className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem', fontWeight: 400 }}>
                    {context.annotation.motivation}
                  </span>
                )}
              </label>
              <div style={{
                padding: '0.75rem',
                backgroundColor: 'var(--semiont-bg-secondary)',
                borderRadius: 'var(--semiont-radius-md)',
                border: '1px solid var(--semiont-border-primary)',
              }}>
                <div className={`semiont-gather__source-context${sourceExpanded ? ' semiont-gather__source-context--expanded' : ''}`}>
                  <div style={{ fontSize: 'var(--semiont-text-sm)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                    {sourceContext.before && <span>{sourceContext.before}</span>}
                    <span style={{
                      backgroundColor: 'var(--semiont-color-primary-100)',
                      padding: '0 0.25rem',
                      fontWeight: 600,
                      color: 'var(--semiont-color-primary-900)',
                    }}>
                      {sourceContext.selected}
                    </span>
                    {sourceContext.after && <span>{sourceContext.after}</span>}
                  </div>
                  {!sourceExpanded && <div className="semiont-gather__source-context-fade" />}
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

            {/* Right: hint + actions */}
            <div className="semiont-gather__right">
              <div className="semiont-form__field">
                <label className="semiont-form__label">
                  {t.userHintLabel}
                </label>
                <textarea
                  value={userHint}
                  onChange={(e) => onUserHintChange(e.target.value)}
                  placeholder={t.userHintPlaceholder}
                  className="semiont-search-modal__search-input"
                  rows={4}
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

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
          </div>
        </>
      )}
    </div>
  );
}
