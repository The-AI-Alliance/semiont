'use client';

import { useState, useEffect, useRef } from 'react';
import type { GatheredContext } from '@semiont/core';
import { ContextSummary } from './ContextSummary';
import type { ContextSummaryTranslations } from './ContextSummary';
import { CorpusPane } from './CorpusPane';
import type { CorpusPaneTranslations } from './CorpusPane';
import { ANNOTATORS, annotatorKeyForMotivation } from '../../lib/annotation-registry';

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
    /** The label states its effect — "steers Search and Generate" (GEP D5). */
    userHintEffect: string;
    userHintPlaceholder: string;
  };
}

export interface GatherContextStepProps {
  context: GatheredContext | null;
  contextLoading: boolean;
  contextError: Error | null;
  /**
   * What the host already knows about the annotation BEFORE the gather
   * answers — its exact text and entity types are wizard props, no wire
   * round-trip needed. When present, the loading state renders them with
   * skeleton panes so the loading screen is the loaded screen minus the
   * data, not a blank modal with dots. Omit (the resource-gather path) for
   * the plain loading block.
   */
  pending?: { exact: string; entityTypes: string[]; resourceName?: string };
  /** Omit for a display-only (e.g. resource-focus) render. */
  annotate?: GatherContextStepAnnotate;
  /**
   * Display-only callers on a STRATEGY step (the chooser already clicked):
   * keep the RESOLUTION STRATEGY band for continuity, collapsed from three
   * choices to the chosen one — a passive echo, never a second chooser.
   * Ignored when `annotate` is present (the live chooser owns the band).
   */
  chosenStrategy?: { label: string; value: string };
  translations: {
    loadingContext: string;
    failedContext: string;
  } & ContextSummaryTranslations & CorpusPaneTranslations;
}

export function GatherContextStep({
  context,
  contextLoading,
  contextError,
  pending,
  annotate,
  chosenStrategy,
  translations: t,
}: GatherContextStepProps) {
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const contextReady = !contextLoading && !contextError && !!context;
  const focus = context?.focus.kind === 'annotation' ? context.focus : null;
  const resourceFocus = context?.focus.kind === 'resource' ? context.focus : null;
  // GEP D6: the focal span WEARS its motivation — the viewer's own registry
  // class (the same one the document applies), never a copy or a chip.
  const focalKey = focus?.annotation.motivation
    ? annotatorKeyForMotivation(focus.annotation.motivation)
    : undefined;
  const focalMotivationClass = focalKey ? ANNOTATORS[focalKey].className : undefined;
  const highlightRef = useRef<HTMLSpanElement>(null);

  // Scroll the highlighted term into view when context loads
  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [context]);

  // Shared by the loaded view and the loading skeleton (the Hint is wizard
  // state — safely typed while the gather runs — and the chooser's buttons
  // already gate on contextReady). One JSX, two hosts: never two copies.
  const hintRow = annotate && (
    <div className="semiont-gather__hint-row">
      <div className="semiont-form__field">
        <label className="semiont-form__label">
          {annotate.translations.userHintLabel}
          <span className="semiont-gather__hint-effect"> — {annotate.translations.userHintEffect}</span>
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
  );

  const strategyFooter = annotate && (
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
  );

  return (
    <div className="semiont-gather__outer">
      {/* Loading / error states. With a `pending` preview the loading screen
          is the loaded screen minus the data: the annotation's own facts and
          the pane headers hold the layout, and one small dots animation sits
          in EACH zone — source excerpt, Neighborhood, Similar passages —
          exactly where its content will land. No central block, no dead
          space; the sentence survives for screen readers. */}
      {contextLoading && pending && (
        <div className="semiont-gather__skeleton" role="status">
          <span className="semiont-sr-only">{t.loadingContext}</span>
          {pending.resourceName && (
            <div className="semiont-gather__skeleton-source">
              {t.sourceContextLabel}{` "${pending.resourceName}"`}
            </div>
          )}
          <div className="semiont-gather__skeleton-dots" aria-hidden="true">
            <span className="semiont-gather__loading-dot" />
            <span className="semiont-gather__loading-dot" />
            <span className="semiont-gather__loading-dot" />
          </div>
          <div className="semiont-gather__skeleton-header">
            {/* Straight quotes — the same presentation the panel entries use. */}
            <span className="semiont-gather__skeleton-exact">"{pending.exact}"</span>
            {pending.entityTypes.length > 0 && (
              <span style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {pending.entityTypes.map(et => (
                  <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400 }}>
                    {et}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="semiont-gather__skeleton-panes">
            <div className="semiont-gather__skeleton-pane">
              <div className="semiont-gather-pane__title">{t.graphPaneTitle}</div>
              <div className="semiont-gather__skeleton-dots" aria-hidden="true">
                <span className="semiont-gather__loading-dot" />
                <span className="semiont-gather__loading-dot" />
                <span className="semiont-gather__loading-dot" />
              </div>
            </div>
            <div className="semiont-gather__skeleton-pane">
              <div className="semiont-gather-pane__title">{t.corpusPaneTitle}</div>
              <div className="semiont-gather__skeleton-dots" aria-hidden="true">
                <span className="semiont-gather__loading-dot" />
                <span className="semiont-gather__loading-dot" />
                <span className="semiont-gather__loading-dot" />
              </div>
            </div>
          </div>
          {hintRow}
          {strategyFooter}
        </div>
      )}
      {contextLoading && !pending && (
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
          {/* Full-width source context strip — annotation focus.
              GEP P1 (D6/D7): the quotation is contiguous prose — anchor
              metadata never interrupts it. Entity chips are tokens and live on
              the label row; the motivation is never labeled, the focal span
              WEARS it via the viewer's own registry class (same class the
              document applies, themes included). Only annotations the context
              can PLACE render here — today exactly `focus.annotation`. */}
          {focus?.selected && (
            <div className="semiont-gather__source-strip">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.375rem' }}>
                <label className="semiont-form__label" style={{ marginBottom: 0 }}>
                  {t.sourceContextLabel}{focus.sourceResource.name ? ` "${focus.sourceResource.name}"` : ''}
                </label>
                {(context.metadata?.entityTypes ?? []).length > 0 && (
                  <span style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    {(context.metadata?.entityTypes ?? []).map(et => (
                      <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400 }}>
                        {et}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className={`semiont-gather__source-box${sourceExpanded ? ' semiont-gather__source-box--expanded' : ''}`}>
                <div className="semiont-gather__source-context">
                  <div style={{ fontSize: 'var(--semiont-text-sm)', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                    {focus.selected.before && <span>{focus.selected.before}</span>}
                    <span ref={highlightRef} {...(focalMotivationClass ? { className: focalMotivationClass } : {})}>
                      {focus.selected.text}
                    </span>
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

          {/* Full-width source context strip — resource focus. Same D6 rule as
              the annotation strip: chips are metadata about the anchor and
              live on the label row, never inside the prose. */}
          {resourceFocus && (
            <div className="semiont-gather__source-strip">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.375rem' }}>
                <label className="semiont-form__label" style={{ marginBottom: 0 }}>
                  {t.sourceContextLabel}{resourceFocus.resource.name ? ` "${resourceFocus.resource.name}"` : ''}
                </label>
                {(context.metadata?.entityTypes ?? []).length > 0 && (
                  <span style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    {(context.metadata?.entityTypes ?? []).map(et => (
                      <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem', fontWeight: 400 }}>
                        {et}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              {(resourceFocus.summary || resourceFocus.content?.main) && (
                <div className={`semiont-gather__source-box${sourceExpanded ? ' semiont-gather__source-box--expanded' : ''}`}>
                  <div className="semiont-gather__source-context">
                    <div style={{ fontSize: 'var(--semiont-text-sm)', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                      {resourceFocus.summary ?? resourceFocus.content?.main}
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

          {/* The evidence panes (GEP D1): curated knowledge beside latent
              knowledge — the fork reads off them. Both render for every
              caller; emptiness is evidence, never blankness. */}
          <div className="semiont-gather__body">
            <div className="semiont-gather__left">
              <ContextSummary context={context} translations={t} />
            </div>
            <div className="semiont-gather__right">
              <CorpusPane semanticContext={context.semanticContext} translations={t} />
            </div>
          </div>

          {/* Hint: full width, input-then-act adjacency above the footer
              (GEP D5). The label states its effect. Typing does NOT re-run
              recall — the panes are the at-gather evidence. */}
          {focus && hintRow}

          {/* Full-width footer: resolution strategy (annotation-wizard callers only).
              The THIRD footer species — a CHOOSER — and the deliberate exception to
              the WizardFooter grammar, which is one-retreat-plus-one-advance and
              cannot express a fork. Its own grammar, pinned in WizardFooter.test:
              • three mutually exclusive strategies, equal width (`--flex` is honest
                here: these ARE peers — the same class the shared footer banned for
                falsely making retreat a peer of advance);
              • no dismissal (corner ✕/Esc, as everywhere);
              • all gated on contextReady;
              • the AI paths are primary, the manual path secondary — Compose's
                demotion is the recorded convention, not drift;
              • ellipses are component-owned and mark step-vs-act: Search…/Generate…
                lead to another step; Compose acts immediately (navigates away). */}
          {focus && strategyFooter}
          {!annotate && chosenStrategy && (
            <div className="semiont-gather__footer">
              <div className="semiont-gather__footer-label">{chosenStrategy.label}</div>
              <div className="semiont-gather__actions">
                <span className="semiont-gather__chosen-strategy">{chosenStrategy.value}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
