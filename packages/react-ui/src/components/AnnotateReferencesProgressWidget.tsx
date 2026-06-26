'use client';

import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from '../hooks/useObservable';
import type { components } from '@semiont/core';

type Motivation = components['schemas']['Motivation'];
type JobProgress = components['schemas']['JobProgress'];

export interface JobProgressWidgetTranslations {
  /** Header title (e.g. "Annotating Entity References" / "Generating Resource"). */
  title: string;
  /** Cancel-button title attribute. */
  cancel: string;
  /** Default in-progress status message (used when the job sends no `message`). */
  inProgress: string;
  complete: string;
  failed: string;
  /** Completed entity-type log line (annotation flow only). */
  found?: (count: number) => string;
  /** Current entity-type status (annotation flow only). */
  current?: (entityType: string) => string;
}

interface AnnotateReferencesProgressWidgetProps {
  progress: JobProgress | null;
  /** CSS `data-type` hook. */
  annotationType?: Motivation | 'reference' | 'generation';
  /** Job type the cancel button requests. */
  cancelJobType: 'annotation' | 'generation';
  translations: JobProgressWidgetTranslations;
}

/**
 * Job-progress widget (header + cancel + status). Shared by the annotation
 * (reference) flow and the resource-generate flow — the title, status copy, and
 * cancel job type are supplied by the caller so neither flow's wording leaks into
 * the other.
 *
 * @emits job:cancel-requested - User requested to cancel the job. Payload: { jobType: string }
 */
export function AnnotateReferencesProgressWidget({ progress, annotationType = 'reference', cancelJobType, translations: tr }: AnnotateReferencesProgressWidgetProps) {
  const session = useObservable(useSemiont().activeSession$);

  const handleCancel = () => {
    session?.client.job.cancelRequest(cancelJobType);
  };

  if (!progress) return null;

  return (
    <div
      className="semiont-annotation-progress"
      data-status={progress.stage}
      data-type={annotationType}
    >
      {/* Header with pulsing sparkle */}
      <div className="semiont-annotation-header">
        <h3 className="semiont-annotation-title">
          <span className="semiont-annotation-sparkle">✨</span>
          {tr.title}
        </h3>
        {progress.stage !== 'complete' && (
          <button
            onClick={handleCancel}
            className="semiont-annotation-cancel"
            title={tr.cancel}
          >
            ✕
          </button>
        )}
      </div>

      {/* Request Parameters */}
      {progress.requestParams && progress.requestParams.length > 0 && (
        <div className="semiont-annotation-progress__params">
          <div className="semiont-annotation-progress__params-title">Request Parameters:</div>
          {progress.requestParams.map((param, idx) => (
            <div key={idx} className="semiont-annotation-progress__param">
              <span className="semiont-annotation-progress__param-label">{param.label}:</span> {param.value}
            </div>
          ))}
        </div>
      )}

      {/* Completed entity types log (annotation flow only) */}
      {tr.found && progress.completedEntityTypes && progress.completedEntityTypes.length > 0 && (
        <div className="semiont-annotation-log">
          {progress.completedEntityTypes.map((item, index) => (
            <div key={index} className="semiont-annotation-log-item">
              <span className="semiont-annotation-check">✓</span>
              <span className="semiont-annotation-entity-type">{item.entityType}:</span>
              <span>{tr.found?.(item.foundCount)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Status display with pulsing animation */}
      <div className="semiont-annotation-progress__status">
        {progress.stage === 'complete' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✅</span>
            <span>{tr.complete}</span>
          </div>
        ) : progress.stage === 'error' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">❌</span>
            <span>{progress.message || tr.failed}</span>
          </div>
        ) : (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✨</span>
            <span>{progress.message || (progress.currentEntityType && tr.current ? tr.current(progress.currentEntityType) : tr.inProgress)}</span>
          </div>
        )}
        {progress.currentEntityType && progress.stage !== 'complete' && progress.stage !== 'error' && (
          <div className="semiont-annotation-progress__details">
            Processing: {progress.currentEntityType}
          </div>
        )}
      </div>
    </div>
  );
}
