'use client';

import { useTranslations } from '../contexts/TranslationContext';
import { useEventBus } from '../contexts/EventBusContext';
import type { DetectionProgress } from '../hooks/useDetectionProgress';
import type { components } from '@semiont/api-client';

type Motivation = components['schemas']['Motivation'];

// Extended DetectionProgress with optional request parameters
interface EnrichedDetectionProgress extends DetectionProgress {
  requestParams?: Array<{ label: string; value: string }>;
}

interface DetectionProgressWidgetProps {
  progress: DetectionProgress | null;
  annotationType?: Motivation | 'reference';
}

/**
 * Widget for displaying detection progress with cancel functionality
 *
 * @emits job:cancel-requested - User requested to cancel detection job. Payload: { jobType: string }
 */
export function DetectionProgressWidget({ progress, annotationType = 'reference' }: DetectionProgressWidgetProps) {
  const t = useTranslations('DetectionProgressWidget');
  const eventBus = useEventBus();

  const handleCancel = () => {
    // Emit event for job cancellation
    eventBus.emit('job:cancel-requested', { jobType: 'detection' });
  };

  if (!progress) return null;

  return (
    <div
      className="semiont-detection-progress"
      data-status={progress.status}
      data-type={annotationType}
    >
      {/* Header with pulsing sparkle */}
      <div className="semiont-detection-header">
        <h3 className="semiont-detection-title">
          <span className="semiont-detection-sparkle">✨</span>
          {t('title')}
        </h3>
        {progress.status !== 'complete' && (
          <button
            onClick={handleCancel}
            className="semiont-detection-cancel"
            title={t('cancelDetection')}
          >
            ✕
          </button>
        )}
      </div>

      {/* Request Parameters */}
      {(() => {
        const enrichedProgress = progress as EnrichedDetectionProgress;
        return enrichedProgress.requestParams && enrichedProgress.requestParams.length > 0 && (
          <div className="semiont-detection-progress__params">
            <div className="semiont-detection-progress__params-title">Request Parameters:</div>
            {enrichedProgress.requestParams.map((param, idx) => (
              <div key={idx} className="semiont-detection-progress__param">
                <span className="semiont-detection-progress__param-label">{param.label}:</span> {param.value}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Completed entity types log */}
      {progress.completedEntityTypes && progress.completedEntityTypes.length > 0 && (
        <div className="semiont-detection-log">
          {progress.completedEntityTypes.map((item, index) => (
            <div key={index} className="semiont-detection-log-item">
              <span className="semiont-detection-check">✓</span>
              <span className="semiont-detection-entity-type">{item.entityType}:</span>
              <span>{t('found', { count: item.foundCount })}</span>
            </div>
          ))}
        </div>
      )}

      {/* Status display with pulsing animation */}
      <div className="semiont-detection-progress__status">
        {progress.status === 'complete' ? (
          <div className="semiont-detection-progress__message">
            <span className="semiont-detection-progress__icon">✅</span>
            <span>{t('complete')}</span>
          </div>
        ) : progress.status === 'error' ? (
          <div className="semiont-detection-progress__message">
            <span className="semiont-detection-progress__icon">❌</span>
            <span>{progress.message || t('failed')}</span>
          </div>
        ) : (
          <div className="semiont-detection-progress__message">
            <span className="semiont-detection-progress__icon">✨</span>
            <span>{progress.message || (progress.currentEntityType ? t('current', { entityType: progress.currentEntityType }) : t('detecting'))}</span>
          </div>
        )}
        {progress.currentEntityType && progress.status !== 'complete' && progress.status !== 'error' && (
          <div className="semiont-detection-progress__details">
            Processing: {progress.currentEntityType}
          </div>
        )}
      </div>
    </div>
  );
}
