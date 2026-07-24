'use client';

import { useState, useEffect, type ReactNode } from 'react';
import type { components } from '@semiont/core';
import { AssistProgress, type AssistProgressProps } from '../../AssistProgress';

type JobProgress = components['schemas']['JobProgress'];

export interface AssistShellProps {
  /** localStorage persist-key suffix and CSS `data-type` ('highlight' | 'comment' | 'assessment' | 'reference' | 'tag'). */
  assistType: string;
  /** Collapsible section title (already translated). */
  title: string;
  isAssisting: boolean;
  progress: JobProgress | null | undefined;
  /** The per-motivation form (fields + submit) — shown when no progress is displayed. */
  form: ReactNode;
  /**
   * Pass-through config for the progress renderer (cancel/dismiss wiring,
   * translations, percent bar). Dismiss policy lives HERE: the shell forwards
   * `onDismiss` only once the assist is no longer running.
   */
  progressProps?: Omit<AssistProgressProps, 'progress' | 'dataType'>;
}

/**
 * The one assist-section chrome (#7): collapsible header with persisted expand
 * state, the assisting wrapper, and the form-vs-progress switch. Every
 * motivation's panel composes this shell with its own fields — the fields
 * differ per motivation by design (instructions/tone/density vs entity chips
 * vs schema+categories), so the shell owns only what is genuinely shared.
 */
export function AssistShell({ assistType, title, isAssisting, progress, form, progressProps }: AssistShellProps) {
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem(`assist-section-expanded-${assistType}`);
    return stored ? stored === 'true' : true;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(`assist-section-expanded-${assistType}`, String(isExpanded));
  }, [isExpanded, assistType]);

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
          className="semiont-assist-widget"
          data-assisting={isAssisting && progress ? 'true' : 'false'}
          data-type={assistType}
        >
          {!progress && form}
          {progress && (
            <AssistProgress
              progress={progress}
              dataType={assistType}
              {...progressProps}
              {...(isAssisting ? { onDismiss: undefined } : {})}
            />
          )}
        </div>
      )}
    </div>
  );
}
