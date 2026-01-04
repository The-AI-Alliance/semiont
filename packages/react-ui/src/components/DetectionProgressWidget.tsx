'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import type { DetectionProgress } from '../hooks/useDetectionProgress';

interface DetectionProgressWidgetProps {
  progress: DetectionProgress | null;
  onCancel?: () => void;
}

export function DetectionProgressWidget({ progress, onCancel }: DetectionProgressWidgetProps) {
  const t = useTranslations('DetectionProgressWidget');

  if (!progress) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 border-2 border-blue-500 dark:border-blue-600">
      {/* Header with pulsing sparkle */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <span className="text-lg animate-sparkle-infinite">✨</span>
          {t('title')}
        </h3>
        {progress.status !== 'complete' && onCancel && (
          <button
            onClick={onCancel}
            className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-sm"
            title={t('cancelDetection')}
          >
            ✕
          </button>
        )}
      </div>

      {/* Request Parameters */}
      {(progress as any).requestParams && (progress as any).requestParams.length > 0 && (
        <div className="mb-3 p-2 bg-blue-50 dark:bg-blue-950/20 rounded border border-blue-200 dark:border-blue-800">
          <div className="text-xs font-semibold text-blue-900 dark:text-blue-100 mb-1">Request Parameters:</div>
          {(progress as any).requestParams.map((param: { label: string; value: string }, idx: number) => (
            <div key={idx} className="text-xs text-blue-800 dark:text-blue-200">
              <span className="font-medium">{param.label}:</span> {param.value}
            </div>
          ))}
        </div>
      )}

      {/* Completed entity types log */}
      {progress.completedEntityTypes && progress.completedEntityTypes.length > 0 && (
        <div className="mb-3 space-y-1">
          {progress.completedEntityTypes.map((item, index) => (
            <div key={index} className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
              <span className="text-green-600 dark:text-green-400">✓</span>
              <span className="font-medium">{item.entityType}:</span>
              <span>{t('found', { count: item.foundCount })}</span>
            </div>
          ))}
        </div>
      )}

      {/* Current entity type progress */}
      <div className="mb-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {progress.status === 'complete' ? (
            <span className="text-green-600 dark:text-green-400 font-medium">
              ✅ {t('complete')}
            </span>
          ) : progress.status === 'error' ? (
            <span className="text-red-600 dark:text-red-400 font-medium">
              ❌ {progress.message || t('failed')}
            </span>
          ) : progress.currentEntityType ? (
            <span className="font-medium">
              {t('current', { entityType: progress.currentEntityType })}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
