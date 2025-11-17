'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

export type SelectionMotivation = 'linking' | 'highlighting' | 'assessing' | 'commenting';
export type ClickMotivation = 'detail' | 'follow' | 'jsonld' | 'deleting';

interface AnnotateToolbarProps {
  selectedSelection: SelectionMotivation | null;
  selectedClick: ClickMotivation;
  onSelectionChange: (motivation: SelectionMotivation | null) => void;
  onClickChange: (motivation: ClickMotivation) => void;
  showSelectionGroup?: boolean;
  showDeleteButton?: boolean;
}

export function AnnotateToolbar({
  selectedSelection,
  selectedClick,
  onSelectionChange,
  onClickChange,
  showSelectionGroup = true,
  showDeleteButton = true
}: AnnotateToolbarProps) {
  const t = useTranslations('AnnotateToolbar');

  const handleSelectionClick = (motivation: SelectionMotivation) => {
    // Toggle: if already selected, deselect it
    onSelectionChange(selectedSelection === motivation ? null : motivation);
  };

  const handleClickClick = (motivation: ClickMotivation) => {
    // Always set the clicked motivation (no toggle)
    onClickChange(motivation);
  };

  const getButtonClass = (motivation: SelectionMotivation | ClickMotivation, isDeleteButton = false) => {
    const isSelected = selectedSelection === motivation || selectedClick === motivation;
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
            aria-pressed={selectedSelection === 'linking'}
          >
            <span className="text-lg">🔵</span>
          </button>

          {/* Highlighting Button */}
          <button
            onClick={() => handleSelectionClick('highlighting')}
            className={getButtonClass('highlighting')}
            title={t('highlighting')}
            aria-pressed={selectedSelection === 'highlighting'}
          >
            <span className="text-lg">🟡</span>
          </button>

          {/* Assessing Button */}
          <button
            onClick={() => handleSelectionClick('assessing')}
            className={getButtonClass('assessing')}
            title={t('assessing')}
            aria-pressed={selectedSelection === 'assessing'}
          >
            <span className="text-lg">🔴</span>
          </button>

          {/* Commenting Button */}
          <button
            onClick={() => handleSelectionClick('commenting')}
            className={getButtonClass('commenting')}
            title={t('commenting')}
            aria-pressed={selectedSelection === 'commenting'}
          >
            <span className="text-lg">💬</span>
          </button>
        </div>
      )}
    </div>
  );
}
