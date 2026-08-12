'use client';

import type { components } from '@semiont/core';
import { EntityFoundLog } from './EntityFoundLog';

type JobProgress = components['schemas']['JobProgress'];

/**
 * Every string this component renders. Required by default and with NO
 * English fallbacks (ASSIST-SURFACE-WARTS Lane A): a `tr.x || 'X'` default
 * turns a forgotten key into English text in a Japanese UI, silently and
 * only at runtime. Required keys make the same mistake a type error at the
 * call site. Only genuinely conditional copy is optional.
 */
export interface AssistProgressTranslations {
  /** Header title (e.g. "Annotating Entity References" / "Generating Resource"). Omit for the headerless inline style. */
  title?: string;
  /** Cancel-button title attribute. */
  cancel: string;
  /** Default in-progress status message (used when the job sends no `message`). */
  inProgress: string;
  /** Status copy for the terminal 'complete' stage. */
  complete: string;
  /** Fallback status copy for the terminal 'error' stage. */
  failed: string;
  /** Request-parameters block heading. */
  paramsTitle: string;
  /** Current-work detail line — the generic form, used by every flow. */
  processing: (label: string) => string;
  /** Completed entity-type log line (reference flow only). */
  found?: (count: number) => string;
  /** Current-work detail line, reference-flow wording; falls back to `processing`. */
  current?: (label: string) => string;
  /** Dismiss-button label. */
  close: string;
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
  translations: AssistProgressTranslations;
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
  translations: tr,
}: AssistProgressProps) {
  const terminal = progress.stage === 'complete' || progress.stage === 'error';
  // The reference flow words this line its own way; everyone else gets the
  // generic one. Both are translated — there is no untranslated branch.
  const currentLabel = tr.current ?? tr.processing;

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
              title={tr.cancel}
              aria-label={tr.cancel}
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
          <div className="semiont-annotation-progress__params-title">{tr.paramsTitle}</div>
          {progress.requestParams.map((param, idx) => (
            <div key={idx} className="semiont-annotation-progress__param">
              <span className="semiont-annotation-progress__param-label">{param.label}:</span> <span>{param.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Completed entity-type log (reference flow) */}
      {tr.found && progress.completedEntityTypes && (
        <EntityFoundLog entries={progress.completedEntityTypes} formatFound={tr.found} />
      )}

      {/* Status line with stage branching */}
      <div className="semiont-annotation-progress__status">
        {progress.stage === 'complete' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✅</span>
            {/* Terminal copy is the client's own translated string. The wire
                carries a code + typed params (`progress.message`), not prose;
                rendering the coded copy is the consolidation arc's P3
                (ASSIST-PROGRESS-CONSOLIDATION). */}
            <span>{tr.complete}</span>
          </div>
        ) : progress.stage === 'error' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">❌</span>
            <span>{tr.failed}</span>
          </div>
        ) : (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✨</span>
            <span>
              {progress.currentEntityType ? currentLabel(progress.currentEntityType) : tr.inProgress}
            </span>
          </div>
        )}

        {/* Current-work detail while running */}
        {!terminal && progress.currentEntityType && (
          <div className="semiont-annotation-progress__details">
            {currentLabel(progress.currentEntityType)}
          </div>
        )}
        {!terminal && progress.currentCategory && (
          <div className="semiont-annotation-progress__details">
            {tr.processing(progress.currentCategory)}
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
            aria-label={tr.close}
            title={tr.close}
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
