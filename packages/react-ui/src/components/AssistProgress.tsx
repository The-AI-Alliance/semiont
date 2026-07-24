'use client';

import type { components } from '@semiont/core';

type JobProgress = components['schemas']['JobProgress'];

export interface AssistProgressTranslations {
  /** Header title (e.g. "Annotating Entity References" / "Generating Resource"). Omit for the headerless inline style. */
  title?: string;
  /** Cancel-button title attribute. */
  cancel?: string;
  /** Default in-progress status message (used when the job sends no `message`). */
  inProgress?: string;
  /** Status copy for the terminal 'complete' stage. */
  complete?: string;
  /** Fallback status copy for the terminal 'error' stage. */
  failed?: string;
  /** Completed entity-type log line (reference flow). */
  found?: (count: number) => string;
  /** Current-work detail line (reference flow). */
  current?: (label: string) => string;
  /** Dismiss-button label. */
  close?: string;
}

export interface AssistProgressProps {
  progress: JobProgress;
  /** CSS `data-type` hook ('highlight' | 'comment' | … | 'reference' | 'tag' | 'generation'). */
  dataType: string;
  /** Cancel the underlying job — rendered while running when provided. Caller wires `client.job.cancelRequest(...)`. */
  onCancel?: () => void;
  /**
   * Dismiss the display — rendered whenever provided. WHEN dismissal is
   * offered is the caller's policy (AssistShell withholds the callback while
   * the assist is still running). Caller wires `client.mark.dismissProgress()`.
   */
  onDismiss?: () => void;
  /** Render the percentage bar (tag flow's visual; percentage itself comes from `progress`). */
  showPercentBar?: boolean;
  translations?: AssistProgressTranslations;
}

/**
 * The one job-progress renderer (#7) — unifies the three previous shapes
 * (AssistSection's inline block, the reference/generation widget, TaggingPanel's
 * inline block). Presentational and provider-free: no session, no context —
 * cancel/dismiss arrive as callbacks, so it renders identically on the page and
 * in embeddable (bring-your-own-session) hosts. Feature blocks are
 * data-presence-driven: each call site keeps its established visuals by passing
 * the data and translations it always had.
 */
export function AssistProgress({
  progress,
  dataType,
  onCancel,
  onDismiss,
  showPercentBar = false,
  translations: tr = {},
}: AssistProgressProps) {
  const terminal = progress.stage === 'complete' || progress.stage === 'error';

  return (
    <div className="semiont-annotation-progress" data-status={progress.stage} data-type={dataType}>
      {/* Header (title + cancel) — reference/generation style; omitted inline */}
      {tr.title && (
        <div className="semiont-annotation-header">
          <h3 className="semiont-annotation-title">
            <span className="semiont-annotation-sparkle">✨</span>
            {tr.title}
          </h3>
          {onCancel && !terminal && (
            <button
              onClick={onCancel}
              className="semiont-annotation-cancel"
              title={tr.cancel || 'Cancel'}
              aria-label={tr.cancel || 'Cancel'}
              type="button"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Request parameters */}
      {progress.requestParams && progress.requestParams.length > 0 && (
        <div className="semiont-annotation-progress__params" data-type={dataType}>
          <div className="semiont-annotation-progress__params-title">Request Parameters:</div>
          {progress.requestParams.map((param, idx) => (
            <div key={idx} className="semiont-annotation-progress__param">
              <span className="semiont-annotation-progress__param-label">{param.label}:</span> <span>{param.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Completed entity-type log (reference flow) */}
      {tr.found && progress.completedEntityTypes && progress.completedEntityTypes.length > 0 && (
        <div className="semiont-annotation-log">
          {progress.completedEntityTypes.map((item, index) => (
            <div key={index} className="semiont-annotation-log-item">
              <span className="semiont-annotation-check">✓</span>
              <span className="semiont-annotation-entity-type">{item.entityType}:</span>
              <span>{tr.found!(item.foundCount)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Status line with stage branching */}
      <div className="semiont-annotation-progress__status">
        {progress.stage === 'complete' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✅</span>
            {/* JobProgress.message is required but may be '' — never blank a terminal line. */}
            <span>{tr.complete || progress.message || 'Complete'}</span>
          </div>
        ) : progress.stage === 'error' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">❌</span>
            <span>{progress.message || tr.failed || 'Failed'}</span>
          </div>
        ) : (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✨</span>
            <span>
              {progress.message
                || (progress.currentEntityType && tr.current ? tr.current(progress.currentEntityType) : tr.inProgress)}
            </span>
          </div>
        )}

        {/* Current-work detail while running */}
        {!terminal && progress.currentEntityType && (
          <div className="semiont-annotation-progress__details">
            {tr.current ? tr.current(progress.currentEntityType) : `Processing: ${progress.currentEntityType}`}
          </div>
        )}
        {!terminal && progress.currentCategory && (
          <div className="semiont-annotation-progress__details">
            Processing: {progress.currentCategory}
            {progress.processedCategories !== undefined && progress.totalCategories !== undefined && (
              <> ({progress.processedCategories}/{progress.totalCategories})</>
            )}
          </div>
        )}

        {/* Dismiss — rendered whenever the caller offers it */}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="semiont-annotation-progress__close"
            aria-label={tr.close || 'Dismiss'}
            title={tr.close || 'Dismiss'}
            type="button"
          >
            ×
          </button>
        )}
      </div>

      {/* Percentage bar (tag flow) */}
      {showPercentBar && progress.percentage !== undefined && (
        <div className="semiont-progress-bar">
          <div className="semiont-progress-bar__fill" data-type={dataType} style={{ width: `${progress.percentage}%` }} />
        </div>
      )}
    </div>
  );
}
