'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { DetectionProgressWidget } from '@/components/DetectionProgressWidget';
import { ReferenceEntry } from './ReferenceEntry';
import type { components, paths } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type ReferencedBy = ResponseContent<paths['/resources/{id}/referenced-by']['get']>['referencedBy'][number];

interface DetectionLog {
  entityType: string;
  foundCount: number;
}

interface Props {
  allEntityTypes: string[];
  isDetecting: boolean;
  detectionProgress: any; // TODO: type this properly
  onDetect: (selectedTypes: string[]) => void;
  onCancelDetection: () => void;
  references?: Annotation[];
  onReferenceClick?: (annotation: Annotation) => void;
  focusedReferenceId?: string | null;
  hoveredReferenceId?: string | null;
  onReferenceHover?: (referenceId: string | null) => void;
  onGenerateDocument?: (title: string) => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  onUpdateReference?: (referenceId: string, updates: Partial<Annotation>) => void;
  annotateMode?: boolean;
  mediaType?: string | undefined;
  referencedBy?: ReferencedBy[];
  referencedByLoading?: boolean;
}

export function ReferencesPanel({
  allEntityTypes,
  isDetecting,
  detectionProgress,
  onDetect,
  onCancelDetection,
  references = [],
  onReferenceClick,
  focusedReferenceId,
  hoveredReferenceId,
  onReferenceHover,
  onGenerateDocument,
  onSearchDocuments,
  onUpdateReference,
  annotateMode = true,
  mediaType,
  referencedBy = [],
  referencedByLoading = false,
}: Props) {
  const t = useTranslations('DetectPanel');
  const tRef = useTranslations('ReferencesPanel');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [lastDetectionLog, setLastDetectionLog] = useState<DetectionLog[] | null>(null);
  const referenceRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort references by their position in the resource
  const sortedReferences = useMemo(() => {
    return [...references].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [references]);

  // Check if detection is supported for this media type
  const isTextResource = mediaType?.startsWith('text/');

  // Handle hoveredReferenceId - scroll to and pulse reference entry
  useEffect(() => {
    if (!hoveredReferenceId) return;

    const referenceElement = referenceRefs.current.get(hoveredReferenceId);

    if (referenceElement && containerRef.current) {
      referenceElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      referenceElement.classList.add('bg-gray-200', 'dark:bg-gray-700');
      setTimeout(() => {
        referenceElement.classList.remove('bg-gray-200', 'dark:bg-gray-700');
      }, 1500);
    }
  }, [hoveredReferenceId]);

  const handleReferenceRef = (referenceId: string, el: HTMLElement | null) => {
    if (el) {
      referenceRefs.current.set(referenceId, el);
    } else {
      referenceRefs.current.delete(referenceId);
    }
  };

  // Clear log when starting new detection
  const handleDetect = () => {
    setLastDetectionLog(null);
    onDetect(selectedEntityTypes);
  };

  // When detection completes, save log
  React.useEffect(() => {
    if (!isDetecting && detectionProgress?.completedEntityTypes) {
      setLastDetectionLog(detectionProgress.completedEntityTypes);
      setSelectedEntityTypes([]);
    }
  }, [isDetecting, detectionProgress]);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🔵</span>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {tRef('referencesTitle')}
          </h2>
        </div>
      </div>

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && isTextResource && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
              {t('title')}
            </h3>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            {/* Show annotation UI only when not detecting and no completed log */}
            {!detectionProgress && !lastDetectionLog && (
            <>
              {/* Entity Types Selection */}
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('selectEntityTypes')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {allEntityTypes.length > 0 ? (
                    allEntityTypes.map((type: string) => (
                      <button
                        key={type}
                        onClick={() => {
                          setSelectedEntityTypes(prev =>
                            prev.includes(type)
                              ? prev.filter(t => t !== type)
                              : [...prev, type]
                          );
                        }}
                        aria-pressed={selectedEntityTypes.includes(type)}
                        aria-label={`${selectedEntityTypes.includes(type) ? t('deselect') : t('select')} ${type}`}
                        className={`px-3 py-1 text-sm rounded-full transition-colors border focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          selectedEntityTypes.includes(type)
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700'
                            : 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                      >
                        {type}
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t('noEntityTypes')}
                    </p>
                  )}
                </div>
              </div>

              {/* Selected Count */}
              {selectedEntityTypes.length > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 text-center mb-4">
                  {t('typesSelected', { count: selectedEntityTypes.length })}
                </p>
              )}

              {/* Start Detection Button */}
              <button
                onClick={handleDetect}
                disabled={selectedEntityTypes.length === 0}
                title={t('startDetection')}
                className={`w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium ${
                  selectedEntityTypes.length > 0
                    ? 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white shadow-md hover:shadow-lg'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                }`}
              >
                <span className="text-2xl">✨</span>
              </button>
            </>
          )}

          {/* Detection Progress - shown when active */}
          {detectionProgress && (
            <DetectionProgressWidget
              progress={detectionProgress}
              onCancel={onCancelDetection}
            />
          )}

          {/* Completed detection log - shown after completion */}
          {!detectionProgress && lastDetectionLog && lastDetectionLog.length > 0 && (
            <div className="space-y-3">
              <div className="space-y-1">
                {lastDetectionLog.map((item, index) => (
                  <div key={index} className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
                    <span className="text-green-600 dark:text-green-400">✓</span>
                    <span className="font-medium">{item.entityType}:</span>
                    <span>{t('found', { count: item.foundCount })}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setLastDetectionLog(null)}
                className="w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white shadow-md hover:shadow-lg"
              >
                {t('more')}
              </button>
            </div>
          )}
            </div>
          </div>
        )}

        {/* References List Section */}
        <div>
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {tRef('outgoingReferences')} ({sortedReferences.length})
            </h3>
          </div>

          <div className="space-y-3">
            {sortedReferences.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                {tRef('noReferences')}
              </p>
            ) : (
              sortedReferences.map((reference) => (
                <ReferenceEntry
                  key={reference.id}
                  reference={reference}
                  isFocused={reference.id === focusedReferenceId}
                  onClick={() => onReferenceClick?.(reference)}
                  onReferenceRef={handleReferenceRef}
                  annotateMode={annotateMode}
                  {...(onReferenceHover && { onReferenceHover })}
                  {...(onGenerateDocument && { onGenerateDocument })}
                  {...(onSearchDocuments && { onSearchDocuments })}
                  {...(onUpdateReference && { onUpdateReference })}
                />
              ))
            )}
          </div>
        </div>

        {/* Referenced By Section */}
        <div>
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {tRef('incomingReferences')}
              {referencedByLoading && (
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">({tRef('loading')})</span>
              )}
            </h3>
          </div>

          {referencedBy.length > 0 ? (
            <div className="space-y-2">
              {referencedBy.map((ref) => (
                <div key={ref.id} className="border border-gray-200 dark:border-gray-700 rounded p-2">
                  <Link
                    href={`/know/resource/${encodeURIComponent(ref.target.source)}`}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline block font-medium mb-1"
                  >
                    {ref.resourceName || tRef('untitledResource')}
                  </Link>
                  <span className="text-xs text-gray-500 dark:text-gray-400 italic line-clamp-2">
                    "{ref.target.selector?.exact || tRef('noText')}"
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {referencedByLoading ? tRef('loadingEllipsis') : tRef('noIncomingReferences')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
