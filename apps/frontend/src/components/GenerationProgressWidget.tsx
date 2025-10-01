'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { buttonStyles } from '@/lib/button-styles';
import '@/styles/animations.css';
import type { GenerationProgress } from '@/hooks/useGenerationProgress';

interface GenerationProgressWidgetProps {
  progress: GenerationProgress | null;
  onCancel?: () => void;
  onDismiss?: () => void;
}

export function GenerationProgressWidget({ progress, onCancel, onDismiss }: GenerationProgressWidgetProps) {
  // Auto-dismiss after 5 seconds on successful completion
  useEffect(() => {
    if (progress?.status === 'complete' && onDismiss) {
      const timer = setTimeout(() => {
        onDismiss();
      }, 5000);

      return () => clearTimeout(timer);
    }
    return undefined;
  }, [progress?.status, onDismiss]);

  if (!progress) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 border-2 border-cyan-500 dark:border-cyan-600">
      {/* Header with sparkle - hide when complete */}
      {progress.status !== 'complete' && (
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <span className="text-lg animate-sparkle-blue">✨</span>
            Generating Document
          </h3>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-sm"
              title="Cancel generation"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Dismiss button - shown for errors and completed state */}
      {(progress.status === 'error' || progress.status === 'complete') && onDismiss && (
        <div className="flex justify-end mb-2">
          <button
            onClick={onDismiss}
            className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-sm"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Document name if available */}
      {progress.documentName && (
        <div className="mb-2">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
            {progress.documentName}
          </p>
        </div>
      )}

      {/* Status message - only show for complete or error */}
      {(progress.status === 'complete' || progress.status === 'error') && (
        <div className="mb-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {progress.status === 'complete' ? (
              <span className="text-gray-900 dark:text-white font-medium">
                ✅ Document generated!
              </span>
            ) : (
              <span className="text-red-600 dark:text-red-400 font-medium">
                ❌ {progress.message || 'Generation failed'}
              </span>
            )}
          </p>
        </div>
      )}

      {/* Progress bar - hide when complete */}
      {progress.status !== 'error' && progress.status !== 'complete' && (
        <div className="mb-3">
          <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-500 ease-out rounded-full"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {getStepLabel(progress.status)}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {progress.percentage}%
            </span>
          </div>
        </div>
      )}


      {/* Link to view the saved draft document when complete */}
      {progress.status === 'complete' && progress.documentId && (
        <div className="mt-3">
          <Link
            href={`/know/document/${encodeURIComponent(progress.documentId)}`}
            className={`${buttonStyles.primary.base} w-full text-center`}
          >
            View Draft Document
          </Link>
        </div>
      )}
    </div>
  );
}

function getStepLabel(status: GenerationProgress['status']): string {
  switch (status) {
    case 'started':
      return 'Starting...';
    case 'fetching':
      return 'Loading source...';
    case 'generating':
      return 'Writing content...';
    case 'creating':
      return 'Saving...';
    case 'complete':
      return 'Complete!';
    case 'error':
      return 'Failed';
    default:
      return 'Processing...';
  }
}