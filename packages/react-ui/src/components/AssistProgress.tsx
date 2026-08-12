'use client';

import type { components } from '@semiont/core';
import { EntityFoundLog } from './EntityFoundLog';

type JobProgress = components['schemas']['JobProgress'];
type JobProgressMessage = components['schemas']['JobProgressMessage'];

/**
 * Every string this component renders. Required by default and with NO English
 * fallbacks (ASSIST-SURFACE-WARTS Lane A): a `tr.x || 'X'` default turns a
 * forgotten key into English text in a Japanese UI, silently and only at
 * runtime. Required keys make the same mistake a type error at the call site.
 *
 * The nine wire codes collapse to ONE required function rather than nine keys:
 * the code→copy switch belongs in one place, and threading nine strings through
 * five call sites would put five copies of it in the tree. Build it with
 * `assistProgressCopy(t)`.
 */
export interface AssistProgressTranslations {
  /** Control label while the run is in flight. */
  cancel: string;
  /** Control label once the run has ended. */
  close: string;
  /** Localized copy for a progress code. */
  message: (m: JobProgressMessage) => string;
  /**
   * Shown when no code has arrived yet — a pure liveness heartbeat, or an event
   * predating the coded wire. `JobProgress.message` is optional for exactly
   * these cases.
   */
  inProgress: string;
  /** The subject line: what is being worked on, with its position when known. */
  subject: (label: string, done?: number, total?: number) => string;
  /** Completed entity-type log line (reference flow only). */
  found?: (count: number) => string;
}

export interface AssistProgressProps {
  progress: JobProgress;
  /** CSS `data-type` hook ('highlight' | 'comment' | … | 'reference' | 'tag' | 'generation'). */
  dataType: string;
  /**
   * The run has ENDED. The owner's fact, not the payload's
   * (ASSIST-PROGRESS-CONSOLIDATION D7): terminality is signalled on
   * `job:complete` / `job:fail`, which `AssistShell` already observes via
   * `isAssisting`. This component deliberately does not read `progress.stage` —
   * no producer in the repo emits a terminal stage, and the two branches that
   * believed the schema's description were unreachable for exactly that reason.
   */
  ended?: boolean;
  /** Cancel the underlying job. Caller wires `client.job.cancelRequest(...)`. */
  onCancel?: () => void;
  /** Dismiss the display. Caller wires `client.mark.dismissProgress()`. */
  onDismiss?: () => void;
  translations: AssistProgressTranslations;
}

/**
 * The one job-progress renderer, for all five motivations.
 *
 * Presentational and provider-free: no session, no context — cancel/dismiss
 * arrive as callbacks, so it renders identically on the page and in embeddable
 * (bring-your-own-session) hosts.
 *
 * One shape for every flow. What varies is DATA, not flags: a bar appears
 * because there is a fraction to fill it, a subject line appears because there
 * is a subject. The previous `title` / `showPercentBar` / `found` / `current`
 * opt-ins produced four unrelated layouts from one component, which is what
 * generated the duplicate renders and doubled chrome this replaces.
 */
export function AssistProgress({
  progress,
  dataType,
  ended = false,
  onCancel,
  onDismiss,
  translations: tr,
}: AssistProgressProps) {
  // Reference and tag flows count different things; both report the same shape.
  const label = progress.currentEntityType ?? progress.currentCategory;
  const done = progress.processedEntityTypes ?? progress.processedCategories;
  const total = progress.totalEntityTypes ?? progress.totalCategories;

  // H1: the params line earns its space only when it says something the status
  // line does not. The ONLY redundant case is a single entity type, where the
  // subject beneath already names it — so that case alone is suppressed.
  //
  // Deliberately NOT `total > 1`: other flows send params that never restate the
  // subject (a highlight run reports Instructions and Density), and those have
  // no `total` at all. Gating on the presence of a count would have hidden
  // genuinely informative parameters — an over-application of H1 caught by
  // AssistSection's highlight fixture.
  const params = total === 1 ? undefined : progress.requestParams;

  // A bar appears when there is something to fill it. `percentage` is the
  // job's own estimate; the fraction is the honest floor when it is absent.
  const percent =
    progress.percentage ??
    (done !== undefined && total ? Math.round((done / total) * 100) : undefined);
  const showBar = done !== undefined && total !== undefined && percent !== undefined;

  return (
    <div className="semiont-assist-progress" data-type={dataType} data-ended={ended}>
      {params && params.length > 0 && (
        <div className="semiont-assist-progress__params" data-testid="semiont-assist-params">
          {/* H1 removed the BLOCK HEADING ("Request Parameters:"), not the
              per-parameter labels: a bare "5" for Density says nothing. */}
          {params.map((param, idx) => (
            <span key={idx} className="semiont-assist-progress__param">
              <span className="semiont-assist-progress__param-label">{param.label}:</span>{' '}
              <span>{param.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* H2: kept uncapped — entity-type counts are small in practice. */}
      {tr.found && progress.completedEntityTypes && (
        <EntityFoundLog entries={progress.completedEntityTypes} formatFound={tr.found} />
      )}

      <div className="semiont-assist-progress__status">
        <span className="semiont-assist-progress__icon" aria-hidden="true">
          {ended ? '✅' : '✨'}
        </span>
        <span data-testid="semiont-assist-status">
          {progress.message ? tr.message(progress.message) : tr.inProgress}
        </span>
      </div>

      {/* H3: stage above, subject beneath. */}
      {label && (
        <div className="semiont-assist-progress__subject" data-testid="semiont-assist-subject">
          {tr.subject(label, done, total)}
        </div>
      )}

      {showBar && (
        <div className="semiont-progress-bar" data-testid="semiont-assist-bar">
          <div
            className="semiont-progress-bar__fill"
            data-type={dataType}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {/* D3: ONE control, its meaning set by the lifecycle. */}
      {(ended ? onDismiss : onCancel) && (
        <button
          onClick={ended ? onDismiss : onCancel}
          className="semiont-assist-progress__control"
          data-testid="semiont-assist-control"
          title={ended ? tr.close : tr.cancel}
          aria-label={ended ? tr.close : tr.cancel}
          type="button"
        >
          ✕
        </button>
      )}
    </div>
  );
}
