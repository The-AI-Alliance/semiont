'use client';

import type { components } from '@semiont/core';
import type { AnnotatorKey } from '../lib/annotation-registry';
import { ItemFoundLog } from './ItemFoundLog';

type JobProgress = components['schemas']['JobProgress'];
type JobProgressMessage = components['schemas']['JobProgressMessage'];

/**
 * Every string this component renders. Required by default and with NO English
 * fallbacks: a `tr.x || 'X'` default turns a forgotten key into English text in
 * a Japanese UI, silently and only at runtime. Required keys make the same
 * mistake a type error at the call site.
 *
 * The wire codes collapse to ONE required function rather than a key apiece:
 * the code→copy switch belongs in one place, and threading a string per code
 * through every call site would put a copy of it at each. Build it with
 * `delegateProgressCopy(t)`.
 */
export interface DelegateProgressTranslations {
  /** Control label while the run is in flight. */
  cancel: string;
  /** Control label once the run has ended. */
  close: string;
  /** Localized copy for a progress code. */
  message: (m: JobProgressMessage) => string;
  /**
   * Shown when the event carries no code — a pure liveness heartbeat, or a
   * producer that sends none. `JobProgress.message` is optional for exactly
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
  /**
   * The found-of-~expected tally (reference flow only). Rendered only
   * when the wire carries BOTH counts: `entitiesExpected` absent means the
   * provider priced nothing — no claim — and a denominator is never
   * manufactured from it. The ~ is the copy's to render: the wire calls the
   * number approximate and the words should too.
   */
  tally?: (found: number, expected: number) => string;
}

/**
 * The CSS `data-type` hook: the annotator registry's keys plus generation. A
 * closed set, so it is typed as one — a typo in a bare string produces unstyled
 * chrome, silently.
 */
export type DelegateDataType = AnnotatorKey | 'generation';

export interface DelegateProgressProps {
  progress: JobProgress;
  dataType: DelegateDataType;
  /**
   * What the finished run produced, offered as a link in the ended frame. The
   * label is the artifact's own name — user content, never translated. Rendered
   * only once `ended`: mid-run there is no outcome to offer, whatever the
   * caller has wired.
   */
  outcome?: { label: string; onOpen: () => void } | undefined;
  /**
   * The owner's terminal sentence, rendered in place of the payload message
   * once `ended`. The producer's final frame is a fire-and-forget emit that
   * can lose the race with `job:complete`, so an ended frame must not trust
   * the last payload to describe the ending — the owner, which signalled
   * `ended`, supplies the words too. Inert while the run is live.
   */
  endedMessage?: string;
  /**
   * The run has ENDED. The owner's fact, not the payload's: terminality is
   * signalled on `job:complete` / `job:fail`, which `DelegateShell` already
   * observes via `isDelegating`. `JobProgress` carries no terminal marker for
   * this component to read.
   *
   * REQUIRED. Nothing about a progress payload can tell this component the run
   * is over, so the owner must say. Were it optional, a call site that forgot
   * it would have a flow that can never reach the ended state — a default of
   * `false` is a wrong answer, not a safe one.
   */
  ended: boolean;
  /** Cancel the underlying job. Caller wires `client.job.cancelRequest(jobType)`. */
  onCancel?: () => void;
  /** Dismiss the display. Caller wires `client.mark.dismissProgress()`. */
  onDismiss?: () => void;
  translations: DelegateProgressTranslations;
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
 * is a subject. Per-flow opt-in flags (a title, a percent bar) would give
 * unrelated layouts from one component, and with them duplicate renders and
 * doubled chrome.
 */
export function DelegateProgress({
  progress,
  dataType,
  ended,
  outcome,
  endedMessage,
  onCancel,
  onDismiss,
  translations: tr,
}: DelegateProgressProps) {
  // One wire vocabulary for every flow: the same fields whichever flow is being
  // drawn, with no `??` chains reconciling per-flow names for the same facts.
  const current = progress.current;
  const done = progress.processed;
  const total = progress.total;

  // The params line earns its space only when it says something the status
  // line does not. The ONLY redundant case is a single entity type, where the
  // subject beneath already names it — so that case alone is suppressed.
  //
  // Deliberately NOT `total > 1`: other flows send params that never restate the
  // subject (a highlight run reports Instructions and Density), and those have
  // no `total` at all. Gating on the presence of a count would hide genuinely
  // informative parameters; DelegateSection's highlight fixture pins this.
  const params = total === 1 ? undefined : progress.requestParams;

  // `percentage` is REQUIRED on JobProgress, so every progress event can fill a
  // bar — the bar's existence is not conditional on anything.
  //
  // Requiring the fraction (`done`/`total`) as well would silently remove the
  // bar from every frame that reports percentage alone, and those are the
  // common case: the highlight, comment, assessment and generation flows send
  // no fraction, and neither does the tag flow's `creating-tag-annotations`
  // frame. The fraction is a richer, optional signal that only flows counting
  // per-item work have; it belongs to the SUBJECT line, not to whether a bar
  // exists.

  return (
    <div className="semiont-delegate-progress" data-type={dataType} data-ended={ended}>
      {params && params.length > 0 && (
        <div className="semiont-delegate-progress__params" data-testid="semiont-delegate-params">
          {/* No block heading, but every parameter keeps its label: a bare
              "5" for Density says nothing. */}
          {params.map((param, idx) => (
            <span key={idx} className="semiont-delegate-progress__param">
              <span className="semiont-delegate-progress__param-label">
                {tr.paramLabel(param.label)}:
              </span>{' '}
              <span>{param.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Kept uncapped — per-item counts are small in practice. */}
      {tr.found && progress.completedItems && (
        <ItemFoundLog entries={progress.completedItems} formatFound={tr.found} />
      )}

      <div className="semiont-delegate-progress__status">
        <span className="semiont-delegate-progress__icon" aria-hidden="true">
          {ended ? '✅' : '✨'}
        </span>
        <span data-testid="semiont-delegate-status">
          {ended && endedMessage
            ? endedMessage
            : progress.message ? tr.message(progress.message) : tr.inProgress}
        </span>
      </div>

      {/* The honest denominator. Present only when the count-verifier
          priced one — both counts from the wire, zero manufactured. */}
      {tr.tally && progress.entitiesFound !== undefined && progress.entitiesExpected !== undefined && (
        <div className="semiont-delegate-progress__tally" data-testid="semiont-delegate-tally">
          {tr.tally(progress.entitiesFound, progress.entitiesExpected)}
        </div>
      )}

      {/* Stage above, subject beneath. */}
      {current && (
        <div className="semiont-delegate-progress__subject" data-testid="semiont-delegate-subject">
          {tr.subject(current, done, total)}
        </div>
      )}

      {/* The finished run's artifact, by name. */}
      {ended && outcome && (
        <button
          type="button"
          onClick={outcome.onOpen}
          className="semiont-delegate-progress__outcome"
          data-testid="semiont-delegate-outcome"
        >
          {outcome.label}
        </button>
      )}

      {/* An ended run is 100% done by definition — the last payload's number
          is a mid-run fact and must not survive the ending. */}
      <div className="semiont-progress-bar" data-testid="semiont-delegate-bar">
        <div
          className="semiont-progress-bar__fill"
          data-type={dataType}
          style={{ width: `${ended ? 100 : progress.percentage}%` }}
        />
      </div>

      {/* ONE control, its meaning set by the lifecycle. */}
      {(ended ? onDismiss : onCancel) && (
        <button
          onClick={ended ? onDismiss : onCancel}
          className="semiont-delegate-progress__control"
          data-testid="semiont-delegate-control"
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
