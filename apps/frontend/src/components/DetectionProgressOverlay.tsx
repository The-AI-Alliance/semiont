'use client';

import React from 'react';
import type { DetectionProgress } from '@/hooks/useDetectionProgress';

interface DetectionProgressOverlayProps {
  progress: DetectionProgress | null;
  onCancel?: () => void;
}

export function DetectionProgressOverlay({ progress, onCancel }: DetectionProgressOverlayProps) {
  if (!progress) return null;

  return (
    <>
      {/* Scanning line animation for document */}
      {progress.status === 'scanning' && progress.percentage < 80 && (
        <div
          className="fixed left-0 right-0 h-1 pointer-events-none z-40 transition-all duration-500"
          style={{
            top: `${Math.min(90, 10 + progress.percentage)}%`,
            background: 'linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.8), transparent)',
            boxShadow: '0 0 20px rgba(59, 130, 246, 0.6)',
            animation: 'pulse 1s ease-in-out infinite'
          }}
        />
      )}

      {/* Progress indicator card */}
      <div className="fixed top-4 right-4 bg-white dark:bg-gray-800 rounded-lg shadow-2xl p-4 z-50 min-w-[320px] border border-gray-200 dark:border-gray-700">
        <div className="flex items-start gap-3">
          {/* Animated sparkle icon */}
          <div className="relative">
            <span className="text-2xl animate-pulse">✨</span>
            {progress.status === 'scanning' && (
              <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full animate-ping" />
            )}
          </div>

          {/* Progress content */}
          <div className="flex-1">
            {/* Title */}
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
              Detecting Entity References
            </h4>

            {/* Status message */}
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
              {progress.message || 'Processing...'}
            </p>

            {/* Current entity type */}
            {progress.currentEntityType && (
              <div className="text-xs text-blue-600 dark:text-blue-400 font-medium mb-2">
                Scanning: {progress.currentEntityType}
              </div>
            )}

            {/* Progress bar */}
            <div className="relative">
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className="bg-gradient-to-r from-blue-500 to-cyan-500 h-2 rounded-full transition-all duration-500 relative"
                  style={{ width: `${progress.percentage}%` }}
                >
                  {/* Shimmer effect */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent rounded-full animate-shimmer" />
                </div>
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

            {/* Statistics */}
            {(progress.foundCount > 0 || progress.createdCount > 0) && (
              <div className="flex gap-4 mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                <div className="text-xs">
                  <span className="text-gray-500 dark:text-gray-400">Found: </span>
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {progress.foundCount}
                  </span>
                </div>
                <div className="text-xs">
                  <span className="text-gray-500 dark:text-gray-400">Created: </span>
                  <span className="font-semibold text-green-600 dark:text-green-400">
                    {progress.createdCount}
                  </span>
                </div>
              </div>
            )}

            {/* Completion message */}
            {progress.status === 'complete' && (
              <div className="mt-3 p-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                <p className="text-xs text-green-700 dark:text-green-400 font-medium">
                  ✅ Detection complete!
                </p>
              </div>
            )}

            {/* Error message */}
            {progress.status === 'error' && (
              <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 rounded-md">
                <p className="text-xs text-red-700 dark:text-red-400">
                  ❌ {progress.message}
                </p>
              </div>
            )}
          </div>

          {/* Cancel button */}
          {onCancel && progress.status !== 'complete' && progress.status !== 'error' && (
            <button
              onClick={onCancel}
              aria-label="Cancel detection"
              className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Cancel detection"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Add shimmer animation to styles */}
      <style jsx>{`
        @keyframes shimmer {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(100%);
          }
        }
        .animate-shimmer {
          animation: shimmer 2s infinite;
        }
      `}</style>
    </>
  );
}