'use client';

import { useTranslations } from '../contexts/TranslationContext';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from '../hooks/useObservable';
import type { components } from '@semiont/core';

type Motivation = components['schemas']['Motivation'];
type JobProgress = components['schemas']['JobProgress'];

interface AnnotateReferencesProgressWidgetProps {
  progress: JobProgress | null;
  annotationType?: Motivation | 'reference';
}

/**
 * Widget for displaying reference annotation progress with cancel functionality
 *
 * @emits job:cancel-requested - User requested to cancel annotation job. Payload: { jobType: string }
 */
export function AnnotateReferencesProgressWidget({ progress, annotationType = 'reference' }: AnnotateReferencesProgressWidgetProps) {
  const t = useTranslations('ReferencesPanel');
  const session = useObservable(useSemiont().activeSession$);

  const handleCancel = () => {
    // Emit event for job cancellation
    session?.client.job.cancelRequest('annotation');
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
          {t('annotationProgressTitle')}
        </h3>
        {progress.stage !== 'complete' && (
          <button
            onClick={handleCancel}
            className="semiont-annotation-cancel"
            title={t('cancelAnnotation')}
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

      {/* Completed entity types log */}
      {progress.completedEntityTypes && progress.completedEntityTypes.length > 0 && (
        <div className="semiont-annotation-log">
          {progress.completedEntityTypes.map((item, index) => (
            <div key={index} className="semiont-annotation-log-item">
              <span className="semiont-annotation-check">✓</span>
              <span className="semiont-annotation-entity-type">{item.entityType}:</span>
              <span>{t('found', { count: item.foundCount })}</span>
            </div>
          ))}
        </div>
      )}

      {/* Status display with pulsing animation */}
      <div className="semiont-annotation-progress__status">
        {progress.stage === 'complete' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✅</span>
            <span>{t('complete')}</span>
          </div>
        ) : progress.stage === 'error' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">❌</span>
            <span>{progress.message || t('failed')}</span>
          </div>
        ) : (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✨</span>
            <span>{progress.message || (progress.currentEntityType ? t('current', { entityType: progress.currentEntityType }) : t('annotating'))}</span>
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
