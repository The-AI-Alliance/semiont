'use client';

import React from 'react';
import { useTranslations } from '../contexts/TranslationContext';
import type { DetectionProgress } from '../hooks/useDetectionProgress';

interface DetectionProgressWidgetProps {
  progress: DetectionProgress | null;
  onCancel?: () => void;
}

export function DetectionProgressWidget({ progress, onCancel }: DetectionProgressWidgetProps) {
  const t = useTranslations('DetectionProgressWidget');

  if (!progress) return null;

  return (
    <div
      className="semiont-detection-progress"
      data-status={progress.status}
    >
      {/* Header with pulsing sparkle */}
      <div className="semiont-detection-header">
        <h3 className="semiont-detection-title">
          <span className="semiont-detection-sparkle">✨</span>
          {t('title')}
        </h3>
        {progress.status !== 'complete' && onCancel && (
          <button
            onClick={onCancel}
            className="semiont-detection-cancel"
            title={t('cancelDetection')}
          >
            ✕
          </button>
        )}
      </div>

      {/* Request Parameters */}
      {(progress as any).requestParams && (progress as any).requestParams.length > 0 && (
        <div className="semiont-detection-params">
          <div className="semiont-detection-params-title">Request Parameters:</div>
          {(progress as any).requestParams.map((param: { label: string; value: string }, idx: number) => (
            <div key={idx} className="semiont-detection-params-item">
              <span className="semiont-detection-params-label">{param.label}:</span> {param.value}
            </div>
          ))}
        </div>
      )}

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

      {/* Current entity type progress */}
      <div className="semiont-detection-current">
        <p className="semiont-detection-status-text">
          {progress.status === 'complete' ? (
            <span className="semiont-detection-status-complete">
              ✅ {t('complete')}
            </span>
          ) : progress.status === 'error' ? (
            <span className="semiont-detection-status-error">
              ❌ {progress.message || t('failed')}
            </span>
          ) : progress.currentEntityType ? (
            <span className="semiont-detection-status-active">
              {t('current', { entityType: progress.currentEntityType })}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
