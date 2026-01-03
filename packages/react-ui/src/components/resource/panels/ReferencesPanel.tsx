'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { DetectionProgressWidget } from '../components/DetectionProgressWidget';
import { ReferenceEntry } from './ReferenceEntry';
import type { components, paths } from '@semiont/api-client';
import { useAnnotationPanel } from '../hooks/useAnnotationPanel';
import { PanelHeader } from './PanelHeader';
import { supportsDetection } from '../lib/resource-utils';

type Annotation = components['schemas']['Annotation'];
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type ReferencedBy = ResponseContent<paths['/resources/{id}/referenced-by']['get']>['referencedBy'][number];

interface DetectionLog {
  entityType: string;
  foundCount: number;
}

interface Props {
  // Generic panel props
  annotations?: Annotation[];
  onAnnotationClick?: (annotation: Annotation) => void;
  focusedAnnotationId?: string | null;
  hoveredAnnotationId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onDetect: (selectedTypes: string[], includeDescriptiveReferences?: boolean) => void;
  onCreate?: (entityType?: string) => void;
  isDetecting: boolean;
  detectionProgress: any; // TODO: type this properly
  annotateMode?: boolean;

  // Reference-specific props
  allEntityTypes: string[];
  onCancelDetection: () => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  onUpdate?: (referenceId: string, updates: Partial<Annotation>) => void;
  onGenerateDocument?: (referenceId: string, options: { title: string; prompt?: string }) => void;
  mediaType?: string | undefined;
  referencedBy?: ReferencedBy[];
  referencedByLoading?: boolean;
  pendingSelection?: {
    exact: string;
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
    svgSelector?: string;
  } | null;
}

export function ReferencesPanel({
  annotations = [],
  onAnnotationClick,
  focusedAnnotationId,
  hoveredAnnotationId,
  onAnnotationHover,
  onDetect,
  onCreate,
  isDetecting,
  detectionProgress,
  annotateMode = true,
  allEntityTypes,
  onCancelDetection,
  onSearchDocuments,
  onUpdate,
  onGenerateDocument,
  mediaType,
  referencedBy = [],
  referencedByLoading = false,
  pendingSelection,
}: Props) {
  const t = useTranslations('DetectPanel');
  const tRef = useTranslations('ReferencesPanel');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [lastDetectionLog, setLastDetectionLog] = useState<DetectionLog[] | null>(null);
  const [pendingEntityTypes, setPendingEntityTypes] = useState<string[]>([]);
  const [includeDescriptiveReferences, setIncludeDescriptiveReferences] = useState(false);

  const { sortedAnnotations, containerRef, handleAnnotationRef } =
    useAnnotationPanel(annotations, hoveredAnnotationId);

  // Check if detection is supported for this media type
  const isTextResource = supportsDetection(mediaType);

  // Clear log when starting new detection
  const handleDetect = () => {
    setLastDetectionLog(null);
    onDetect(selectedEntityTypes, includeDescriptiveReferences);
  };

  // When detection completes, save log
  React.useEffect(() => {
    if (!isDetecting && detectionProgress?.completedEntityTypes) {
      setLastDetectionLog(detectionProgress.completedEntityTypes);
      setSelectedEntityTypes([]);
    }
  }, [isDetecting, detectionProgress]);

  const togglePendingEntityType = (type: string) => {
    setPendingEntityTypes(prev =>
      prev.includes(type)
        ? prev.filter(t => t !== type)
        : [...prev, type]
    );
  };

  const handleCreateReference = () => {
    if (onCreate) {
      const entityType = pendingEntityTypes.join(',') || undefined;
      onCreate(entityType);
      setPendingEntityTypes([]);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <PanelHeader annotationType="reference" count={annotations.length} title={tRef('referencesTitle')} />

      {/* New reference creation - shown when there's a pending selection */}
      {pendingSelection && onCreate && (
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/10">
          <div className="text-sm text-gray-600 dark:text-gray-400 italic mb-2 border-l-2 border-blue-300 pl-2">
            {pendingSelection.svgSelector
              ? tRef('imageRegionSelected')
              : `"${pendingSelection.exact.substring(0, 100)}${pendingSelection.exact.length > 100 ? '...' : ''}"`
            }
          </div>

          {/* Entity Types Multi-Select */}
          {allEntityTypes.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
                {tRef('entityTypesOptional')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {allEntityTypes.map((type: string) => (
                  <button
                    key={type}
                    onClick={() => togglePendingEntityType(type)}
                    className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                      pendingEntityTypes.includes(type)
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={handleCreateReference}
            className="w-full px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium"
          >
            🔗 {tRef('createReference')}
          </button>
        </div>
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && isTextResource && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
              {t('title')}
            </h3>
            {/* Show annotation UI only when not detecting and no completed log */}
            {!detectionProgress && !lastDetectionLog && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
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

              {/* Include Descriptive References Checkbox */}
              <div className="mb-4">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeDescriptiveReferences}
                    onChange={(e) => setIncludeDescriptiveReferences(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
                  />
                  <span>{tRef('includeDescriptiveReferences')}</span>
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                  {tRef('descriptiveReferencesTooltip')}
                </p>
              </div>

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
            </div>
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
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 space-y-3">
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
        )}

        {/* References List Section */}
        <div>
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {tRef('outgoingReferences')} ({sortedAnnotations.length})
            </h3>
          </div>

          <div className="space-y-3">
            {sortedAnnotations.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                {tRef('noReferences')}
              </p>
            ) : (
              sortedAnnotations.map((reference) => (
                <ReferenceEntry
                  key={reference.id}
                  reference={reference}
                  isFocused={reference.id === focusedAnnotationId}
                  onClick={() => onAnnotationClick?.(reference)}
                  onReferenceRef={handleAnnotationRef}
                  annotateMode={annotateMode}
                  {...(onAnnotationHover && { onReferenceHover: onAnnotationHover })}
                  {...(onGenerateDocument && { onGenerateDocument })}
                  {...(onSearchDocuments && { onSearchDocuments })}
                  {...(onUpdate && { onUpdateReference: onUpdate })}
                />
              ))
            )}
          </div>
        </div>

        {/* Referenced By Section */}
        <div>
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {tRef('incomingReferences')} ({referencedBy.length})
              {referencedByLoading && (
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">({tRef('loading')})</span>
              )}
            </h3>
          </div>

          {referencedBy.length > 0 ? (
            <div className="space-y-2">
              {referencedBy.map((ref) => {
                // Extract resource ID from full URI (e.g., "http://localhost:4000/resources/abc123" -> "abc123")
                const resourceId = ref.target.source.split('/').pop() || '';

                return (
                  <div key={ref.id} className="border border-gray-200 dark:border-gray-700 rounded p-2">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-sm text-gray-700 dark:text-gray-300 font-medium">
                        {ref.resourceName || tRef('untitledResource')}
                      </span>
                      <Link
                        href={`/know/resource/${resourceId}`}
                        className="text-lg hover:opacity-70 transition-opacity flex-shrink-0"
                        title={tRef('open')}
                      >
                        🔗
                      </Link>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 italic line-clamp-2">
                      "{ref.target.selector?.exact || tRef('noText')}"
                    </span>
                  </div>
                );
              })}
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
