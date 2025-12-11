'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ANNOTATORS } from '@/lib/annotation-registry';

interface DetectSectionProps {
  annotationType: 'highlight' | 'assessment' | 'comment';
  isDetecting: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
    requestParams?: Array<{ label: string; value: string }>;
  } | null | undefined;
  onDetect: (instructions?: string, tone?: string) => void | Promise<void>;
}

const colorSchemes = {
  highlight: {
    border: 'border-yellow-500 dark:border-yellow-600',
    button: 'from-yellow-600 to-amber-600 hover:from-yellow-700 hover:to-amber-700',
  },
  assessment: {
    border: 'border-red-500 dark:border-red-600',
    button: 'from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700',
  },
  comment: {
    border: 'border-purple-500 dark:border-purple-600',
    button: 'from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700',
  }
};

/**
 * Shared detect section for Highlight, Assessment, and Comment panels
 *
 * Provides:
 * - Optional instructions textarea
 * - Optional tone selector (for comments)
 * - Detect button with sparkle animation
 * - Progress display during detection
 */
export function DetectSection({
  annotationType,
  isDetecting,
  detectionProgress,
  onDetect
}: DetectSectionProps) {
  const panelName = annotationType === 'highlight' ? 'HighlightPanel' :
                     annotationType === 'assessment' ? 'AssessmentPanel' :
                     'CommentsPanel';
  const t = useTranslations(panelName);
  const [instructions, setInstructions] = useState('');
  const [tone, setTone] = useState('');
  const metadata = ANNOTATORS[annotationType]!;
  const colors = colorSchemes[annotationType];

  const handleDetect = () => {
    onDetect(
      instructions.trim() || undefined,
      annotationType === 'comment' && tone ? tone : undefined
    );
    setInstructions('');
    setTone('');
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
        {t(annotationType === 'highlight' ? 'detectHighlights' :
           annotationType === 'assessment' ? 'detectAssessments' :
           'detectComments')}
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

            {/* Tone selector - only for comments */}
            {annotationType === 'comment' && (
              <div className="mb-4">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                  {t('toneLabel')} {t('toneOptional')}
                </label>
                <select
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                  className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
                >
                  <option value="">Default</option>
                  <option value="scholarly">{t('toneScholarly')}</option>
                  <option value="explanatory">{t('toneExplanatory')}</option>
                  <option value="conversational">{t('toneConversational')}</option>
                  <option value="technical">{t('toneTechnical')}</option>
                </select>
              </div>
            )}

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
            {/* Request Parameters */}
            {detectionProgress.requestParams && detectionProgress.requestParams.length > 0 && (
              <div className="mb-3 p-2 bg-blue-50 dark:bg-blue-950/20 rounded border border-blue-200 dark:border-blue-800">
                <div className="text-xs font-semibold text-blue-900 dark:text-blue-100 mb-1">Request Parameters:</div>
                {detectionProgress.requestParams.map((param, idx) => (
                  <div key={idx} className="text-xs text-blue-800 dark:text-blue-200">
                    <span className="font-medium">{param.label}:</span> {param.value}
                  </div>
                ))}
              </div>
            )}

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
