'use client';

import type { components } from '@semiont/core';
import { ItemFoundLog } from './ItemFoundLog';

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
  /**
   * The subject line: what is being worked on, with its position when known.
   * Takes the wire's `{ kind, value }` — the localized name for `kind` is the
   * translation layer's business, not this component's.
   */
  subject: (current: NonNullable<JobProgress['current']>, done?: number, total?: number) => string;
  /**
   * Localized NAME for an echoed request parameter. The wire sends a code
   * (`instructions`, `tone`, …); the VALUE beside it is the user's own words
   * and is never translated.
   */
  paramLabel: (code: string) => string;
  /** Completed entity-type log line (reference flow only). */
  found?: (count: number) => string;
}

/**
 * The CSS `data-type` hook: five motivations plus generation. A closed set, so
 * it is typed as one — a typo used to produce unstyled chrome, silently
 * (CLEAN-PROGRESS A9).
 */
export type AssistDataType =
  | 'highlight' | 'comment' | 'assessment' | 'reference' | 'tag' | 'generation';

export interface AssistProgressProps {
  progress: JobProgress;
  dataType: AssistDataType;
  /**
   * What the finished run produced, offered as a link in the ended frame
   * (GENERATE-FROM-RESOURCE D8). The label is the artifact's own name — user
   * content, never translated. Rendered only once `ended`: mid-run there is no
   * outcome to offer, whatever the caller has wired.
   */
  outcome?: { label: string; onOpen: () => void } | undefined;
  /**
   * The run has ENDED. The owner's fact, not the payload's
   * (ASSIST-PROGRESS-CONSOLIDATION D7): terminality is signalled on
   * `job:complete` / `job:fail`, which `AssistShell` already observes via
   * `isAssisting`. This component deliberately does not read `progress.stage` —
   * no producer in the repo emits a terminal stage, and the two branches that
   * believed the schema's description were unreachable for exactly that reason.
   *
   * REQUIRED (CLEAN-PROGRESS A1). It was optional, and the one call site that
   * forgot it shipped a flow that could never reach the ended state at all.
   * Nothing about a progress payload can tell this component the run is over,
   * so the owner must say — and a default of `false` is a wrong answer, not a
   * safe one.
   */
  ended: boolean;
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
  ended,
  outcome,
  onCancel,
  onDismiss,
  translations: tr,
}: AssistProgressProps) {
  // One vocabulary, so no guessing (CLEAN-PROGRESS D2). This used to be a pair
  // of `??` chains reconciling entity-type fields with category fields — the
  // component had to know which flow it was drawing to find the same two facts.
  const current = progress.current;
  const done = progress.processed;
  const total = progress.total;

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

  // `percentage` is REQUIRED on JobProgress, so every progress event can fill a
  // bar — the bar's existence is not conditional on anything.
  //
  // It used to also require the fraction (`done`/`total`), which SILENTLY
  // REMOVED THE TAG FLOW'S BAR: `processTagJob` reports percentage only and
  // emits no category fields at all, so `done`/`total` are permanently
  // undefined there (caught in review of PR #1179). The fraction is a richer,
  // optional signal that only flows counting per-item work have; it belongs to
  // the SUBJECT line, not to whether a bar exists.

  return (
    <div className="semiont-assist-progress" data-type={dataType} data-ended={ended}>
      {params && params.length > 0 && (
        <div className="semiont-assist-progress__params" data-testid="semiont-assist-params">
          {/* H1 removed the BLOCK HEADING ("Request Parameters:"), not the
              per-parameter labels: a bare "5" for Density says nothing. */}
          {params.map((param, idx) => (
            <span key={idx} className="semiont-assist-progress__param">
              <span className="semiont-assist-progress__param-label">
                {tr.paramLabel(param.label)}:
              </span>{' '}
              <span>{param.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* H2: kept uncapped — per-item counts are small in practice. */}
      {tr.found && progress.completedItems && (
        <ItemFoundLog entries={progress.completedItems} formatFound={tr.found} />
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
      {current && (
        <div className="semiont-assist-progress__subject" data-testid="semiont-assist-subject">
          {tr.subject(current, done, total)}
        </div>
      )}

      {/* D8: the finished run's artifact, by name. */}
      {ended && outcome && (
        <button
          type="button"
          onClick={outcome.onOpen}
          className="semiont-assist-progress__outcome"
          data-testid="semiont-assist-outcome"
        >
          {outcome.label}
        </button>
      )}

      <div className="semiont-progress-bar" data-testid="semiont-assist-bar">
        <div
          className="semiont-progress-bar__fill"
          data-type={dataType}
          style={{ width: `${progress.percentage}%` }}
        />
      </div>

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
