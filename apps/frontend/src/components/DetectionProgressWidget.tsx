'use client';

import React from 'react';
import type { DetectionProgress } from '@/hooks/useDetectionProgress';

interface DetectionProgressWidgetProps {
  progress: DetectionProgress | null;
  onCancel?: () => void;
}

export function DetectionProgressWidget({ progress, onCancel }: DetectionProgressWidgetProps) {
  if (!progress) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 border-2 border-blue-500 dark:border-blue-600">
      {/* Header with pulsing sparkle */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <span className="text-lg animate-sparkle-infinite">✨</span>
          Detecting Entity References
        </h3>
        {progress.status !== 'complete' && onCancel && (
          <button
            onClick={onCancel}
            className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-sm"
            title="Cancel detection"
          >
            ✕
          </button>
        )}
      </div>

      {/* Completed entity types log */}
      {progress.completedEntityTypes && progress.completedEntityTypes.length > 0 && (
        <div className="mb-3 space-y-1">
          {progress.completedEntityTypes.map((item, index) => (
            <div key={index} className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
              <span className="text-green-600 dark:text-green-400">✓</span>
              <span className="font-medium">{item.entityType}:</span>
              <span>{item.foundCount} found</span>
            </div>
          ))}
        </div>
      )}

      {/* Current entity type progress */}
      <div className="mb-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {progress.status === 'complete' ? (
            <span className="text-green-600 dark:text-green-400 font-medium">
              ✅ Detection complete!
            </span>
          ) : progress.status === 'error' ? (
            <span className="text-red-600 dark:text-red-400 font-medium">
              ❌ {progress.message || 'Detection failed'}
            </span>
          ) : progress.currentEntityType ? (
            <span className="font-medium">
              Current: {progress.currentEntityType}
            </span>
          ) : (
            <span className="font-medium">
              {progress.processedEntityTypes} of {progress.totalEntityTypes} entity types
            </span>
          )}
        </p>
      </div>

      {/* Info text */}
      {progress.status !== 'error' && progress.status !== 'complete' && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 italic">
          New references appear in document's History as they're detected
        </p>
      )}
    </div>
  );
}
