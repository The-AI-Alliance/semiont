'use client';

import { useState, useEffect, type ReactNode } from 'react';
import type { components } from '@semiont/core';
import { DelegateProgress, type DelegateProgressProps, type DelegateDataType } from '../../DelegateProgress';

type JobProgress = components['schemas']['JobProgress'];

export interface DelegateShellProps {
  /** localStorage persist-key suffix and CSS `data-type`. */
  delegateType: DelegateDataType;
  /** Collapsible section title (already translated). */
  title: string;
  isDelegating: boolean;
  progress: JobProgress | null | undefined;
  /** The per-motivation form (fields + submit) — shown when no progress is displayed. */
  form: ReactNode;
  /**
   * Pass-through config for the progress renderer (cancel/dismiss wiring,
   * translations, percent bar). Dismiss policy lives HERE: the shell forwards
   * `onDismiss` only once the delegated job is no longer running.
   *
   * Required because `translations` is: the shell renders the progress display
   * itself, so a caller that omitted this would render untranslated chrome —
   * the failure the widget's required translations exist to make impossible.
   */
  progressProps: Omit<DelegateProgressProps, 'progress' | 'dataType' | 'ended'>;
}

/**
 * The one delegate-section chrome: collapsible header with persisted expand
 * state, the delegating wrapper, and the form-vs-progress switch. Every
 * motivation's panel composes this shell with its own fields — the fields
 * differ per motivation by design (instructions/tone/density vs entity chips
 * vs schema+categories), so the shell owns only what is genuinely shared.
 */
export function DelegateShell({ delegateType, title, isDelegating, progress, form, progressProps }: DelegateShellProps) {
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem(`delegate-section-expanded-${delegateType}`);
    return stored ? stored === 'true' : true;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(`delegate-section-expanded-${delegateType}`, String(isExpanded));
  }, [isExpanded, delegateType]);

  return (
    <div className="semiont-panel__section">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="semiont-panel__section-title semiont-panel__section-title--collapsible"
        aria-expanded={isExpanded}
        type="button"
      >
        <span>{title}</span>
        <span className="semiont-panel__section-chevron" data-expanded={isExpanded}>
          ›
        </span>
      </button>
      {isExpanded && (
        <div
          className="semiont-delegate-widget"
          data-delegating={isDelegating && progress ? 'true' : 'false'}
          data-type={delegateType}
        >
          {!progress && form}
          {progress && (
            <DelegateProgress
              progress={progress}
              dataType={delegateType}
              // `ended` is deliberately NOT in `progressProps` (it is Omit'd):
              // the shell watches the job lifecycle, so a panel cannot get this
              // wrong or forget it.
              // Terminality is the OWNER's fact. `isDelegating` follows the
              // job lifecycle (job:complete / job:fail); the widget must never
              // infer "done" from a progress payload, which cannot tell it
              // about a cancel or a crash after the last tick.
              ended={!isDelegating}
              {...progressProps}
              {...(isDelegating ? { onDismiss: undefined } : {})}
            />
          )}
        </div>
      )}
    </div>
  );
}
