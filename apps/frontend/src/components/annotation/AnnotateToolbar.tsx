'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

export type AnnotationMotivation = 'linking' | 'highlighting' | 'assessing' | 'commenting' | 'detail' | 'deleting' | 'jsonld';

interface AnnotateToolbarProps {
  selectedMotivation: AnnotationMotivation;
  onMotivationChange: (motivation: AnnotationMotivation) => void;
}

export function AnnotateToolbar({ selectedMotivation, onMotivationChange }: AnnotateToolbarProps) {
  const t = useTranslations('AnnotateToolbar');

  const getButtonClass = (motivation: AnnotationMotivation, isDeleteButton = false) => {
    const isSelected = selectedMotivation === motivation;
    const baseClasses = 'px-4 py-2 rounded-md transition-colors flex items-center gap-2 font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 border';

    if (isDeleteButton) {
      // Delete button keeps red background
      return `${baseClasses} ${
        isSelected
          ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700 ring-2 ring-red-500 shadow-md'
          : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700 hover:bg-red-200 dark:hover:bg-red-900/50 focus:ring-red-500'
      }`;
    }

    // All other buttons: no background, grayscale text, standard borders
    return `${baseClasses} ${
      isSelected
        ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100 border-gray-400 dark:border-gray-500 ring-2 ring-gray-500 shadow-md'
        : 'text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 focus:ring-gray-500'
    }`;
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Reference Button */}
      <button
        onClick={() => onMotivationChange('linking')}
        className={getButtonClass('linking')}
        title={t('linking')}
        aria-pressed={selectedMotivation === 'linking'}
      >
        <span className="text-lg">🔵</span>
      </button>

      {/* Highlighting Button */}
      <button
        onClick={() => onMotivationChange('highlighting')}
        className={getButtonClass('highlighting')}
        title={t('highlighting')}
        aria-pressed={selectedMotivation === 'highlighting'}
      >
        <span className="text-lg">🟡</span>
      </button>

      {/* Assessing Button */}
      <button
        onClick={() => onMotivationChange('assessing')}
        className={getButtonClass('assessing')}
        title={t('assessing')}
        aria-pressed={selectedMotivation === 'assessing'}
      >
        <span className="text-lg">🔴</span>
      </button>

      {/* Commenting Button */}
      <button
        onClick={() => onMotivationChange('commenting')}
        className={getButtonClass('commenting')}
        title={t('commenting')}
        aria-pressed={selectedMotivation === 'commenting'}
      >
        <span className="text-lg">💬</span>
      </button>

      {/* Separator */}
      <div className="h-8 w-px bg-gray-300 dark:bg-gray-600 mx-2" />

      {/* Detail Button */}
      <button
        onClick={() => onMotivationChange('detail')}
        className={getButtonClass('detail')}
        title={t('detail')}
        aria-pressed={selectedMotivation === 'detail'}
      >
        <span className="text-lg">🔍</span>
      </button>

      {/* JSON-LD Button */}
      <button
        onClick={() => onMotivationChange('jsonld')}
        className={getButtonClass('jsonld')}
        title={t('jsonld')}
        aria-pressed={selectedMotivation === 'jsonld'}
      >
        <span className="text-lg">🌐</span>
      </button>

      {/* Delete Button */}
      <button
        onClick={() => onMotivationChange('deleting')}
        className={getButtonClass('deleting', true)}
        title={t('deleting')}
        aria-pressed={selectedMotivation === 'deleting'}
      >
        <span className="text-lg">🗑️</span>
      </button>
    </div>
  );
}
