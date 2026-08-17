'use client';

import { useState, useEffect, useRef } from 'react';
import type { GatheredContext } from '@semiont/core';
import { ContextSummary } from './ContextSummary';
import type { ContextSummaryTranslations } from './ContextSummary';

/**
 * The annotation-wizard resolution controls, as ONE optional group: a caller
 * either serves the whole surface (hint + Bind/Generate/Compose, with their
 * labels) or none of it. This is what keeps a display-only caller from having
 * to pass `''` for keys it will never render (GENERATE-FROM-RESOURCE D2).
 */
export interface GatherContextStepAnnotate {
  userHint: string;
  onUserHintChange: (value: string) => void;
  onBind: () => void;
  onGenerate: () => void;
  onCompose: () => void;
  translations: {
    search: string;
    generate: string;
    compose: string;
    resolutionStrategyLabel: string;
    userHintLabel: string;
    userHintPlaceholder: string;
  };
}

export interface GatherContextStepProps {
  context: GatheredContext | null;
  contextLoading: boolean;
  contextError: Error | null;
  /** Omit for a display-only (e.g. resource-focus) render. */
  annotate?: GatherContextStepAnnotate;
  translations: {
    loadingContext: string;
    failedContext: string;
  } & ContextSummaryTranslations;
}

export function GatherContextStep({
  context,
  contextLoading,
  contextError,
  annotate,
  translations: t,
}: GatherContextStepProps) {
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const contextReady = !contextLoading && !contextError && !!context;
  const focus = context?.focus.kind === 'annotation' ? context.focus : null;
  const resourceFocus = context?.focus.kind === 'resource' ? context.focus : null;
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
          {/* Full-width source context strip — annotation focus */}
          {focus?.selected && (
            <div className="semiont-gather__source-strip">
              <label className="semiont-form__label" style={{ marginBottom: '0.375rem' }}>
                {t.sourceContextLabel}{focus.sourceResource.name ? ` "${focus.sourceResource.name}"` : ''}
              </label>
              <div className={`semiont-gather__source-box${sourceExpanded ? ' semiont-gather__source-box--expanded' : ''}`}>
                <div className="semiont-gather__source-context">
                  <div style={{ fontSize: 'var(--semiont-text-sm)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                    {focus.selected.before && <span>{focus.selected.before}</span>}
                    <span
                      ref={highlightRef}
                      style={{
                        backgroundColor: 'var(--semiont-color-primary-100)',
                        padding: '0 0.25rem',
                        fontWeight: 600,
                        color: 'var(--semiont-color-primary-900)',
                      }}
                    >
                      {focus.selected.text}
                    </span>
                    {(context.metadata?.entityTypes ?? []).map(et => (
                      <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400, verticalAlign: 'middle', marginLeft: '0.25rem' }}>
                        {et}
                      </span>
                    ))}
                    {focus.annotation.motivation && (
                      <span className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400, verticalAlign: 'middle', marginLeft: '0.25rem' }}>
                        {focus.annotation.motivation}
                      </span>
                    )}
                    {focus.selected.after && <span>{focus.selected.after}</span>}
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

          {/* Full-width source context strip — resource focus */}
          {resourceFocus && (
            <div className="semiont-gather__source-strip">
              <label className="semiont-form__label" style={{ marginBottom: '0.375rem' }}>
                {t.sourceContextLabel}{resourceFocus.resource.name ? ` "${resourceFocus.resource.name}"` : ''}
              </label>
              {(resourceFocus.summary || resourceFocus.content?.main) && (
                <div className={`semiont-gather__source-box${sourceExpanded ? ' semiont-gather__source-box--expanded' : ''}`}>
                  <div className="semiont-gather__source-context">
                    <div style={{ fontSize: 'var(--semiont-text-sm)', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                      {resourceFocus.summary ?? resourceFocus.content?.main}
                      {(context.metadata?.entityTypes ?? []).map(et => (
                        <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400, verticalAlign: 'middle', marginLeft: '0.25rem' }}>
                          {et}
                        </span>
                      ))}
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
              )}
              {resourceFocus.suggestedReferences && resourceFocus.suggestedReferences.length > 0 && (
                // Prose, not chips (D3): the live values are full research
                // prompts — sentences. The chip vocabulary stays for tokens.
                <ul className="semiont-gather__suggested">
                  {resourceFocus.suggestedReferences.map(ref => (
                    <li key={ref}>{ref}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Two-column body */}
          <div className="semiont-gather__body">
            {/* Left: context summary (graph views) */}
            <div className="semiont-gather__left">
              <ContextSummary context={context} translations={t} />
            </div>

            {/* Right: hint textarea (annotation-wizard callers only) */}
            {focus && annotate && (
              <div className="semiont-gather__right">
                <div className="semiont-form__field">
                  <label className="semiont-form__label">
                    {annotate.translations.userHintLabel}
                  </label>
                  <textarea
                    value={annotate.userHint}
                    onChange={(e) => annotate.onUserHintChange(e.target.value)}
                    placeholder={annotate.translations.userHintPlaceholder}
                    className="semiont-search-modal__search-input semiont-gather__hint-textarea"
                    style={{ resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Full-width footer: resolution strategy (annotation-wizard callers only) */}
          {focus && annotate && (
            <div className="semiont-gather__footer">
              <div className="semiont-gather__footer-label">{annotate.translations.resolutionStrategyLabel}</div>
              <div className="semiont-gather__actions">
                <button
                  type="button"
                  onClick={annotate.onBind}
                  disabled={!contextReady}
                  className="semiont-button--primary semiont-button--flex"
                >
                  🔍 {annotate.translations.search}…
                </button>
                <button
                  type="button"
                  onClick={annotate.onGenerate}
                  disabled={!contextReady}
                  className="semiont-button--primary semiont-button--flex"
                >
                  ✨ {annotate.translations.generate}…
                </button>
                <button
                  type="button"
                  onClick={annotate.onCompose}
                  disabled={!contextReady}
                  className="semiont-button--secondary semiont-button--flex"
                >
                  ✍️ {annotate.translations.compose}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
