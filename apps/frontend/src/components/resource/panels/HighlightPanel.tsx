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
  annotateMode?: boolean;
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
  annotateMode = true,
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
      setInstructions('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {ANNOTATION_TYPES.highlight!.iconEmoji} {t('title')} ({highlights.length})
        </h2>
      </div>

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && onDetectHighlights && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
              {t('detectHighlights')}
            </h3>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
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
                    className="w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium bg-gradient-to-r from-yellow-600 to-amber-600 hover:from-yellow-700 hover:to-amber-700 text-white shadow-md hover:shadow-lg"
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
                </div>
              )}
            </div>
          </div>
        )}

        {/* Highlights list */}
        <div className="space-y-4">
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
    </div>
  );
}
