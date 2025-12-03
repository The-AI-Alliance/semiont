'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ANNOTATION_TYPES } from '@/lib/annotation-registry';

interface DetectSectionProps {
  annotationType: 'highlight' | 'assessment';
  isDetecting: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null | undefined;
  onDetect: (instructions?: string) => void | Promise<void>;
}

const colorSchemes = {
  highlight: {
    border: 'border-yellow-500 dark:border-yellow-600',
    button: 'from-yellow-600 to-amber-600 hover:from-yellow-700 hover:to-amber-700',
  },
  assessment: {
    border: 'border-red-500 dark:border-red-600',
    button: 'from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700',
  }
};

/**
 * Shared detect section for Highlight and Assessment panels
 *
 * Provides:
 * - Optional instructions textarea
 * - Detect button with sparkle animation
 * - Progress display during detection
 */
export function DetectSection({
  annotationType,
  isDetecting,
  detectionProgress,
  onDetect
}: DetectSectionProps) {
  const t = useTranslations(`${annotationType === 'highlight' ? 'HighlightPanel' : 'AssessmentPanel'}`);
  const [instructions, setInstructions] = useState('');
  const metadata = ANNOTATION_TYPES[annotationType]!;
  const colors = colorSchemes[annotationType];

  const handleDetect = () => {
    onDetect(instructions.trim() || undefined);
    setInstructions('');
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
        {t(annotationType === 'highlight' ? 'detectHighlights' : 'detectAssessments')}
      </h3>
      <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 ${
        isDetecting && detectionProgress ? `border-2 ${colors.border}` : ''
      }`}>
        {!isDetecting && !detectionProgress && (
          <>
            <div className="mb-4">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                {t('instructions')} {t('optional')}
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
                rows={3}
                placeholder={t('instructionsPlaceholder')}
                maxLength={500}
              />
              <div className="text-xs text-gray-500 mt-1">
                {instructions.length}/500
              </div>
            </div>

            <button
              onClick={handleDetect}
              className={`w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium bg-gradient-to-r ${colors.button} text-white shadow-md hover:shadow-lg`}
            >
              <span className="text-2xl">✨</span>
            </button>
          </>
        )}

        {/* Detection Progress */}
        {isDetecting && detectionProgress && (
          <div className="space-y-3">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <div className="flex items-center gap-2">
                <span className="text-lg animate-sparkle-infinite">✨</span>
                <span>{detectionProgress.message}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
