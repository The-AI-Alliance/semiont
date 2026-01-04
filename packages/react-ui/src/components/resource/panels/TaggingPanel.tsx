'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { TagEntry } from './TagEntry';
import { useAnnotationPanel } from '../../../hooks/useAnnotationPanel';
import { PanelHeader } from './PanelHeader';
import { getAllTagSchemas, type TagSchema } from '../../../lib/tag-schemas';

type Annotation = components['schemas']['Annotation'];

interface TaggingPanelProps {
  annotations: Annotation[];
  onAnnotationClick: (annotation: Annotation) => void;
  focusedAnnotationId: string | null;
  hoveredAnnotationId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  annotateMode?: boolean;
  onDetect?: (schemaId: string, categories: string[]) => void | Promise<void>;
  onCreate?: (selection: { exact: string; start: number; end: number }, schemaId: string, category: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    currentCategory?: string;
    processedCategories?: number;
    totalCategories?: number;
    message?: string;
    requestParams?: Array<{ label: string; value: string }>;
  } | null;
  pendingSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;
}

export function TaggingPanel({
  annotations,
  onAnnotationClick,
  focusedAnnotationId,
  hoveredAnnotationId,
  onAnnotationHover,
  annotateMode = true,
  onDetect,
  onCreate,
  isDetecting = false,
  detectionProgress,
  pendingSelection
}: TaggingPanelProps) {
  const t = useTranslations('TaggingPanel');
  const [selectedSchemaId, setSelectedSchemaId] = useState<string>('legal-irac');
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());

  const { sortedAnnotations, containerRef, handleAnnotationRef } =
    useAnnotationPanel(annotations, hoveredAnnotationId);

  const schemas = getAllTagSchemas();
  const selectedSchema = schemas.find(s => s.id === selectedSchemaId);

  const handleSchemaChange = (schemaId: string) => {
    setSelectedSchemaId(schemaId);
    setSelectedCategories(new Set()); // Reset categories when schema changes
  };

  const handleCategoryToggle = (category: string) => {
    const newCategories = new Set(selectedCategories);
    if (newCategories.has(category)) {
      newCategories.delete(category);
    } else {
      newCategories.add(category);
    }
    setSelectedCategories(newCategories);
  };

  const handleSelectAll = () => {
    if (selectedSchema) {
      setSelectedCategories(new Set(selectedSchema.tags.map(t => t.name)));
    }
  };

  const handleDeselectAll = () => {
    setSelectedCategories(new Set());
  };

  const handleDetect = () => {
    if (onDetect && selectedCategories.size > 0) {
      onDetect(selectedSchemaId, Array.from(selectedCategories));
      setSelectedCategories(new Set()); // Reset after detection
    }
  };

  const categoryColors = {
    border: 'border-orange-500 dark:border-orange-600',
    button: 'from-orange-600 to-amber-600 hover:from-orange-700 hover:to-amber-700',
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <PanelHeader annotationType="tag" count={annotations.length} title={t('title')} />

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Pending Manual Tag Creation */}
        {pendingSelection && onCreate && (
          <div className="bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4 mb-4">
            <h3 className="text-sm font-semibold text-orange-900 dark:text-orange-100 mb-2">
              {t('createTagForSelection')}
            </h3>
            <div className="p-3 bg-white dark:bg-gray-800 rounded border-l-4 border-orange-500 mb-3">
              <p className="text-sm text-gray-700 dark:text-gray-300 italic">
                "{pendingSelection.exact.substring(0, 100)}{pendingSelection.exact.length > 100 ? '...' : ''}"
              </p>
            </div>

            {/* Schema and Category Selection for Manual Tag */}
            <div className="mb-3">
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">
                {t('selectSchema')}
              </label>
              <select
                value={selectedSchemaId}
                onChange={(e) => handleSchemaChange(e.target.value)}
                className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
              >
                {schemas.map(schema => (
                  <option key={schema.id} value={schema.id}>
                    {t(`schema${schema.id === 'legal-irac' ? 'Legal' : schema.id === 'scientific-imrad' ? 'Scientific' : 'Argument'}`)}
                  </option>
                ))}
              </select>
            </div>

            {selectedSchema && (
              <div className="mb-3">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">
                  {t('selectCategory')}
                </label>
                <select
                  className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
                  onChange={(e) => {
                    if (e.target.value) {
                      onCreate(pendingSelection, selectedSchemaId, e.target.value);
                    }
                  }}
                  defaultValue=""
                >
                  <option value="">{t('chooseCategory')}</option>
                  {selectedSchema.tags.map((tag) => (
                    <option key={tag.name} value={tag.name}>{tag.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Detection Section - only in Annotate mode */}
        {annotateMode && onDetect && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
              {t('detectTags')}
            </h3>
            <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 ${
              isDetecting && detectionProgress ? `border-2 ${categoryColors.border}` : ''
            }`}>
              {!isDetecting && !detectionProgress && (
                <>
                  {/* Schema Selector */}
                  <div className="mb-4">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                      {t('selectSchema')}
                    </label>
                    <select
                      value={selectedSchemaId}
                      onChange={(e) => handleSchemaChange(e.target.value)}
                      className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
                    >
                      {schemas.map(schema => (
                        <option key={schema.id} value={schema.id}>
                          {t(`schema${schema.id === 'legal-irac' ? 'Legal' : schema.id === 'scientific-imrad' ? 'Scientific' : 'Argument'}`)}
                        </option>
                      ))}
                    </select>
                    {selectedSchema && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {selectedSchema.description}
                      </p>
                    )}
                  </div>

                  {/* Category Selector */}
                  {selectedSchema && (
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {t('selectCategories')}
                        </label>
                        <div className="flex gap-2">
                          <button
                            onClick={handleSelectAll}
                            className="text-xs text-orange-600 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300"
                          >
                            {t('selectAll')}
                          </button>
                          <span className="text-xs text-gray-400">|</span>
                          <button
                            onClick={handleDeselectAll}
                            className="text-xs text-orange-600 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300"
                          >
                            {t('deselectAll')}
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {selectedSchema.tags.map(category => (
                          <div key={category.name} className="border border-gray-200 dark:border-gray-700 rounded p-3">
                            <label className="flex items-start gap-3 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={selectedCategories.has(category.name)}
                                onChange={() => handleCategoryToggle(category.name)}
                                className="mt-1 w-4 h-4 text-orange-600 border-gray-300 rounded focus:ring-orange-500"
                              />
                              <div className="flex-1">
                                <div className="font-medium text-sm text-gray-900 dark:text-gray-100 group-hover:text-orange-600 dark:group-hover:text-orange-400">
                                  {t(`category${category.name.replace(/\s+/g, '')}`)}
                                </div>
                                <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                                  {category.description}
                                </div>
                              </div>
                            </label>
                          </div>
                        ))}
                      </div>

                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                        {t('categoriesSelected', { count: selectedCategories.size })}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleDetect}
                    disabled={selectedCategories.size === 0}
                    className={`w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium bg-gradient-to-r ${categoryColors.button} text-white shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className="flex items-center justify-center gap-2">
                      <span className="text-2xl">✨</span>
                      <span>{t('detect')}</span>
                    </span>
                  </button>
                </>
              )}

              {/* Detection Progress */}
              {isDetecting && detectionProgress && (
                <div className="space-y-3">
                  {/* Request Parameters */}
                  {detectionProgress.requestParams && detectionProgress.requestParams.length > 0 && (
                    <div className="mb-3 p-2 bg-orange-50 dark:bg-orange-950/20 rounded border border-orange-200 dark:border-orange-800">
                      <div className="text-xs font-semibold text-orange-900 dark:text-orange-100 mb-1">Request Parameters:</div>
                      {detectionProgress.requestParams.map((param, idx) => (
                        <div key={idx} className="text-xs text-orange-800 dark:text-orange-200">
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
                    {detectionProgress.currentCategory && (
                      <div className="mt-2 text-xs text-gray-500">
                        Processing: {detectionProgress.currentCategory}
                        {detectionProgress.processedCategories !== undefined && detectionProgress.totalCategories !== undefined && (
                          <> ({detectionProgress.processedCategories}/{detectionProgress.totalCategories})</>
                        )}
                      </div>
                    )}
                  </div>
                  {detectionProgress.percentage !== undefined && (
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-gradient-to-r from-orange-500 to-amber-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${detectionProgress.percentage}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tags list */}
        <div className="space-y-4">
          {sortedAnnotations.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              {t('noTags')}
            </p>
          ) : (
            sortedAnnotations.map((tag) => (
              <TagEntry
                key={tag.id}
                tag={tag}
                isFocused={tag.id === focusedAnnotationId}
                onClick={() => onAnnotationClick(tag)}
                onTagRef={handleAnnotationRef}
                {...(onAnnotationHover && { onTagHover: onAnnotationHover })}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
