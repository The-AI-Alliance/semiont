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
      {/* Header with sparkle */}
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

      {/* Status message */}
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
          ) : (
            progress.message || 'Processing...'
          )}
        </p>

        {progress.currentEntityType && progress.status !== 'complete' && (
          <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
            Current: {progress.currentEntityType}
          </p>
        )}
      </div>

      {/* Progress bar */}
      {progress.status !== 'error' && (
        <div className="mb-3">
          <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-600 to-cyan-600 transition-all duration-300 ease-out rounded-full"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {progress.processedEntityTypes}/{progress.totalEntityTypes} types
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {progress.percentage}%
            </span>
          </div>
        </div>
      )}

      {/* Statistics */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-50 dark:bg-gray-900/50 rounded p-2">
          <span className="text-gray-500 dark:text-gray-400 block">Found</span>
          <span className="font-semibold text-gray-900 dark:text-white">
            {progress.foundCount}
          </span>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900/50 rounded p-2">
          <span className="text-gray-500 dark:text-gray-400 block">Created</span>
          <span className="font-semibold text-gray-900 dark:text-white">
            {progress.createdCount}
          </span>
        </div>
      </div>
    </div>
  );
}