'use client';

import { useTranslations } from '../contexts/TranslationContext';
import { useEventBus } from '../contexts/EventBusContext';
import type { AnnotationProgress } from '@semiont/core';
import type { components } from '@semiont/core';

type Motivation = components['schemas']['Motivation'];

// Extended AnnotationProgress with optional request parameters
interface EnrichedAnnotationProgress extends AnnotationProgress {
  requestParams?: Array<{ label: string; value: string }>;
}

interface AnnotateReferencesProgressWidgetProps {
  progress: AnnotationProgress | null;
  annotationType?: Motivation | 'reference';
}

/**
 * Widget for displaying reference annotation progress with cancel functionality
 *
 * @emits job:cancel-requested - User requested to cancel annotation job. Payload: { jobType: string }
 */
export function AnnotateReferencesProgressWidget({ progress, annotationType = 'reference' }: AnnotateReferencesProgressWidgetProps) {
  const t = useTranslations('AnnotateReferencesProgressWidget');
  const eventBus = useEventBus();

  const handleCancel = () => {
    // Emit event for job cancellation
    eventBus.get('job:cancel-requested').next({ jobType: 'annotation' });
  };

  if (!progress) return null;

  return (
    <div
      className="semiont-annotation-progress"
      data-status={progress.status}
      data-type={annotationType}
    >
      {/* Header with pulsing sparkle */}
      <div className="semiont-annotation-header">
        <h3 className="semiont-annotation-title">
          <span className="semiont-annotation-sparkle">✨</span>
          {t('title')}
        </h3>
        {progress.status !== 'complete' && (
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
      {(() => {
        const enrichedProgress = progress as EnrichedAnnotationProgress;
        return enrichedProgress.requestParams && enrichedProgress.requestParams.length > 0 && (
          <div className="semiont-annotation-progress__params">
            <div className="semiont-annotation-progress__params-title">Request Parameters:</div>
            {enrichedProgress.requestParams.map((param, idx) => (
              <div key={idx} className="semiont-annotation-progress__param">
                <span className="semiont-annotation-progress__param-label">{param.label}:</span> {param.value}
              </div>
            ))}
          </div>
        );
      })()}

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
        {progress.status === 'complete' ? (
          <div className="semiont-annotation-progress__message">
            <span className="semiont-annotation-progress__icon">✅</span>
            <span>{t('complete')}</span>
          </div>
        ) : progress.status === 'error' ? (
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
        {progress.currentEntityType && progress.status !== 'complete' && progress.status !== 'error' && (
          <div className="semiont-annotation-progress__details">
            Processing: {progress.currentEntityType}
          </div>
        )}
      </div>
    </div>
  );
}
