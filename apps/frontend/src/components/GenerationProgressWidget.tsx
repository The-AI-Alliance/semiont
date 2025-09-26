'use client';

import React from 'react';
import Link from 'next/link';
import type { GenerationProgress } from '@/hooks/useGenerationProgress';

interface GenerationProgressWidgetProps {
  progress: GenerationProgress | null;
  onCancel?: () => void;
  onDismiss?: () => void;
}

export function GenerationProgressWidget({ progress, onCancel, onDismiss }: GenerationProgressWidgetProps) {
  if (!progress) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 border-2 border-purple-500 dark:border-purple-600">
      {/* Header with sparkle */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <span className="text-lg animate-sparkle-infinite">✨</span>
          {progress.status === 'complete' ? 'Document Generated' : 'Generating Document'}
        </h3>
        {progress.status === 'complete' && onDismiss ? (
          <button
            onClick={onDismiss}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
            title="Dismiss"
          >
            ✕
          </button>
        ) : progress.status !== 'complete' && onCancel ? (
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
            title="Cancel generation"
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* Document name if available */}
      {progress.documentName && (
        <div className="mb-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">Creating:</p>
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
            {progress.documentName}
          </p>
        </div>
      )}

      {/* Status message */}
      <div className="mb-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {progress.status === 'complete' ? (
            <span className="text-green-600 dark:text-green-400 font-medium">
              ✅ Document created successfully!
            </span>
          ) : progress.status === 'error' ? (
            <span className="text-red-600 dark:text-red-400 font-medium">
              ❌ {progress.message || 'Generation failed'}
            </span>
          ) : (
            progress.message || 'Processing...'
          )}
        </p>
      </div>

      {/* Progress bar */}
      {progress.status !== 'error' && (
        <div className="mb-3">
          <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-purple-600 to-pink-600 transition-all duration-500 ease-out rounded-full"
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

      {/* AI animation for generating step */}
      {progress.status === 'generating' && (
        <div className="flex justify-center mb-3">
          <div className="flex space-x-1">
            <div className="w-2 h-2 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '0s' }}></div>
            <div className="w-2 h-2 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
            <div className="w-2 h-2 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
          </div>
        </div>
      )}

      {/* Link to view the saved draft document when complete */}
      {progress.status === 'complete' && progress.documentId && (
        <div className="mt-3">
          <Link
            href={`/know/document/${progress.documentId}`}
            className="block w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg text-center transition-colors"
          >
            📄 View Draft Document
          </Link>
        </div>
      )}
    </div>
  );
}

function getStepLabel(status: GenerationProgress['status']): string {
  switch (status) {
    case 'started':
      return 'Initializing...';
    case 'fetching':
      return 'Fetching source...';
    case 'generating':
      return 'AI generating content...';
    case 'creating':
      return 'Saving document...';
    case 'complete':
      return 'Complete!';
    case 'error':
      return 'Failed';
    default:
      return 'Processing...';
  }
}