'use client';

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { HighlightEntry } from './HighlightEntry';
import { ANNOTATION_TYPES } from '@/lib/annotation-registry';

type Annotation = components['schemas']['Annotation'];

interface HighlightPanelProps {
  highlights: Annotation[];
  onHighlightClick: (annotation: Annotation) => void;
  focusedHighlightId: string | null;
  hoveredHighlightId?: string | null;
  onHighlightHover?: (highlightId: string | null) => void;
  resourceContent: string;
  onDetectHighlights?: (instructions?: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
}

export function HighlightPanel({
  highlights,
  onHighlightClick,
  focusedHighlightId,
  hoveredHighlightId,
  onHighlightHover,
  resourceContent,
  onDetectHighlights,
  isDetecting = false,
  detectionProgress,
}: HighlightPanelProps) {
  const t = useTranslations('HighlightPanel');
  const [showDetect, setShowDetect] = useState(false);
  const [instructions, setInstructions] = useState('');
  const highlightRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort highlights by their position in the resource
  const sortedHighlights = useMemo(() => {
    return [...highlights].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [highlights]);

  // Handle hoveredHighlightId - scroll to and pulse highlight entry
  useEffect(() => {
    if (!hoveredHighlightId) return;

    const highlightElement = highlightRefs.current.get(hoveredHighlightId);

    if (highlightElement && containerRef.current) {
      highlightElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      highlightElement.classList.add('bg-gray-200', 'dark:bg-gray-700');
      setTimeout(() => {
        highlightElement.classList.remove('bg-gray-200', 'dark:bg-gray-700');
      }, 1500);
    }
  }, [hoveredHighlightId]);

  const handleHighlightRef = (highlightId: string, el: HTMLElement | null) => {
    if (el) {
      highlightRefs.current.set(highlightId, el);
    } else {
      highlightRefs.current.delete(highlightId);
    }
  };

  const handleDetect = () => {
    if (onDetectHighlights) {
      onDetectHighlights(instructions.trim() || undefined);
      setShowDetect(false);
      setInstructions('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {ANNOTATION_TYPES.highlight!.iconEmoji} {t('title')} ({highlights.length})
          </h2>
          {onDetectHighlights && (
            <button
              onClick={() => setShowDetect(!showDetect)}
              className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              title={t('detectHighlights')}
            >
              ✨
            </button>
          )}
        </div>
      </div>

      {/* Detect highlights UI */}
      {showDetect && onDetectHighlights && (
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-yellow-50 dark:bg-yellow-900/10">
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('instructions')} {t('optional')}
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="w-full mt-1 p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
                rows={2}
                placeholder={t('instructionsPlaceholder')}
                maxLength={500}
                disabled={isDetecting}
              />
              <div className="text-xs text-gray-500 mt-1">
                {instructions.length}/500
              </div>
            </div>

            {detectionProgress && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <div className="flex items-center gap-2">
                  {detectionProgress.percentage !== undefined && (
                    <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-yellow-600 h-2 rounded-full transition-all"
                        style={{ width: `${detectionProgress.percentage}%` }}
                      />
                    </div>
                  )}
                  <span>{detectionProgress.message}</span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleDetect}
                disabled={isDetecting}
                className="px-3 py-1 bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {isDetecting ? t('detecting') : t('detect')}
              </button>
              <button
                onClick={() => setShowDetect(false)}
                disabled={isDetecting}
                className="px-3 py-1 border rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-sm disabled:opacity-50"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Highlights list */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {sortedHighlights.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            {t('noHighlights')}
          </p>
        ) : (
          sortedHighlights.map((highlight) => (
            <HighlightEntry
              key={highlight.id}
              highlight={highlight}
              isFocused={highlight.id === focusedHighlightId}
              onClick={() => onHighlightClick(highlight)}
              onHighlightRef={handleHighlightRef}
              {...(onHighlightHover && { onHighlightHover })}
              resourceContent={resourceContent}
            />
          ))
        )}
      </div>
    </div>
  );
}
