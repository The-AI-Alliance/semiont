'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ANNOTATORS } from '@/lib/annotation-registry';

export type SelectionMotivation = 'linking' | 'highlighting' | 'assessing' | 'commenting' | 'tagging';
export type ClickAction = 'detail' | 'follow' | 'jsonld' | 'deleting';
export type ShapeType = 'rectangle' | 'circle' | 'polygon';

// Map SelectionMotivation to AnnotatorKey for emoji lookup
const MOTIVATION_TO_KEY: Record<SelectionMotivation, keyof typeof ANNOTATORS> = {
  linking: 'reference',
  highlighting: 'highlight',
  assessing: 'assessment',
  commenting: 'comment',
  tagging: 'tag'
};

// Helper to get emoji from registry (with fallback for safety)
const getMotivationEmoji = (motivation: SelectionMotivation): string => {
  return ANNOTATORS[MOTIVATION_TO_KEY[motivation]]?.iconEmoji || '❓';
};

interface AnnotateToolbarProps {
  selectedMotivation: SelectionMotivation | null;
  selectedClick: ClickAction;
  onSelectionChange: (motivation: SelectionMotivation | null) => void;
  onClickChange: (motivation: ClickAction) => void;
  showSelectionGroup?: boolean;
  showDeleteButton?: boolean;
  showShapeGroup?: boolean;
  selectedShape?: ShapeType;
  onShapeChange?: (shape: ShapeType) => void;
}

export function AnnotateToolbar({
  selectedMotivation,
  selectedClick,
  onSelectionChange,
  onClickChange,
  showSelectionGroup = true,
  showDeleteButton = true,
  showShapeGroup = false,
  selectedShape = 'rectangle',
  onShapeChange
}: AnnotateToolbarProps) {
  const t = useTranslations('AnnotateToolbar');

  const handleSelectionClick = (motivation: SelectionMotivation) => {
    // Toggle: if already selected, deselect it
    onSelectionChange(selectedMotivation === motivation ? null : motivation);
  };

  const handleClickClick = (motivation: ClickAction) => {
    // Always set the clicked motivation (no toggle)
    onClickChange(motivation);
  };

  const handleShapeClick = (shape: ShapeType) => {
    // Always set the clicked shape (no toggle)
    if (onShapeChange) {
      onShapeChange(shape);
    }
  };

  const getButtonClass = (motivation: SelectionMotivation | ClickAction | ShapeType, isDeleteButton = false) => {
    const isSelected = selectedMotivation === motivation || selectedClick === motivation || selectedShape === motivation;
    const baseClasses = 'px-3 py-1.5 rounded-md transition-all flex items-center font-medium border-none focus:outline-none';

    if (isDeleteButton) {
      // Delete button has deep red background when selected
      return `${baseClasses} ${
        isSelected
          ? 'bg-red-600 dark:bg-red-800 text-white dark:text-red-50 shadow-[inset_0_4px_8px_rgba(0,0,0,0.3)] translate-y-1 scale-95'
          : 'text-red-700 dark:text-red-400 shadow-sm hover:bg-red-50 dark:hover:bg-red-950/20'
      }`;
    }

    // All other buttons: strong depressed effect when selected
    return `${baseClasses} ${
      isSelected
        ? 'bg-gray-300 dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-[inset_0_4px_8px_rgba(0,0,0,0.3)] translate-y-1 scale-95'
        : 'text-gray-700 dark:text-gray-300 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800'
    }`;
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Click Group */}
      <div className="flex items-center gap-0 hover:bg-blue-100/80 dark:hover:bg-blue-900/30 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-md border border-transparent rounded-lg px-2 py-1 transition-all">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mr-2">
          {t('clickGroup')}
        </span>

        {/* Detail Button */}
        <button
          onClick={() => handleClickClick('detail')}
          className={getButtonClass('detail')}
          title={t('detail')}
          aria-pressed={selectedClick === 'detail'}
        >
          <span className="text-lg">🔍</span>
        </button>

        {/* Follow Button */}
        <button
          onClick={() => handleClickClick('follow')}
          className={getButtonClass('follow')}
          title={t('follow')}
          aria-pressed={selectedClick === 'follow'}
        >
          <span className="text-lg">➡️</span>
        </button>

        {/* JSON-LD Button */}
        <button
          onClick={() => handleClickClick('jsonld')}
          className={getButtonClass('jsonld')}
          title={t('jsonld')}
          aria-pressed={selectedClick === 'jsonld'}
        >
          <span className="text-lg">🌐</span>
        </button>

        {/* Delete Button */}
        {showDeleteButton && (
          <button
            onClick={() => handleClickClick('deleting')}
            className={getButtonClass('deleting', true)}
            title={t('deleting')}
            aria-pressed={selectedClick === 'deleting'}
          >
            <span className="text-lg">🗑️</span>
          </button>
        )}
      </div>

      {/* Separator */}
      {showSelectionGroup && <div className="h-8 w-px bg-gray-300 dark:bg-gray-600 mx-2" />}

      {/* Selection Group */}
      {showSelectionGroup && (
        <div className="flex items-center gap-0 hover:bg-blue-100/80 dark:hover:bg-blue-900/30 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-md border border-transparent rounded-lg px-2 py-1 transition-all">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mr-2">
            {t('selectionGroup')}
          </span>

          {/* Reference Button */}
          <button
            onClick={() => handleSelectionClick('linking')}
            className={getButtonClass('linking')}
            title={t('linking')}
            aria-pressed={selectedMotivation === 'linking'}
          >
            <span className="text-lg">{getMotivationEmoji('linking')}</span>
          </button>

          {/* Highlighting Button */}
          <button
            onClick={() => handleSelectionClick('highlighting')}
            className={getButtonClass('highlighting')}
            title={t('highlighting')}
            aria-pressed={selectedMotivation === 'highlighting'}
          >
            <span className="text-lg">{getMotivationEmoji('highlighting')}</span>
          </button>

          {/* Assessing Button */}
          <button
            onClick={() => handleSelectionClick('assessing')}
            className={getButtonClass('assessing')}
            title={t('assessing')}
            aria-pressed={selectedMotivation === 'assessing'}
          >
            <span className="text-lg">{getMotivationEmoji('assessing')}</span>
          </button>

          {/* Commenting Button */}
          <button
            onClick={() => handleSelectionClick('commenting')}
            className={getButtonClass('commenting')}
            title={t('commenting')}
            aria-pressed={selectedMotivation === 'commenting'}
          >
            <span className="text-lg">{getMotivationEmoji('commenting')}</span>
          </button>

          {/* Tagging Button */}
          <button
            onClick={() => handleSelectionClick('tagging')}
            className={getButtonClass('tagging')}
            title={t('tagging')}
            aria-pressed={selectedMotivation === 'tagging'}
          >
            <span className="text-lg">{getMotivationEmoji('tagging')}</span>
          </button>
        </div>
      )}

      {/* Separator */}
      {showShapeGroup && <div className="h-8 w-px bg-gray-300 dark:bg-gray-600 mx-2" />}

      {/* Shape Group */}
      {showShapeGroup && (
        <div className="flex items-center gap-0 hover:bg-blue-100/80 dark:hover:bg-blue-900/30 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-md border border-transparent rounded-lg px-2 py-1 transition-all">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mr-2">
            {t('shapeGroup')}
          </span>

          {/* Rectangle Button */}
          <button
            onClick={() => handleShapeClick('rectangle')}
            className={getButtonClass('rectangle')}
            title={t('rectangle')}
            aria-pressed={selectedShape === 'rectangle'}
          >
            <span className="text-lg">▭</span>
          </button>

          {/* Circle Button */}
          <button
            onClick={() => handleShapeClick('circle')}
            className={getButtonClass('circle')}
            title={t('circle')}
            aria-pressed={selectedShape === 'circle'}
          >
            <span className="text-lg">○</span>
          </button>

          {/* Polygon Button */}
          <button
            onClick={() => handleShapeClick('polygon')}
            className={getButtonClass('polygon')}
            title={t('polygon')}
            aria-pressed={selectedShape === 'polygon'}
          >
            <span className="text-lg">⬡</span>
          </button>
        </div>
      )}
    </div>
  );
}
