'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

export type AnnotationMotivation = 'linking' | 'highlighting' | 'assessing' | 'commenting' | 'deleting' | 'jsonld';

interface AnnotateToolbarProps {
  selectedMotivation: AnnotationMotivation;
  onMotivationChange: (motivation: AnnotationMotivation) => void;
}

export function AnnotateToolbar({ selectedMotivation, onMotivationChange }: AnnotateToolbarProps) {
  const t = useTranslations('AnnotateToolbar');

  const getButtonClass = (motivation: AnnotationMotivation, baseColor: string, hoverColor: string, textColor: string, ringColor: string) => {
    const isSelected = selectedMotivation === motivation;
    return `px-4 py-2 rounded-md transition-colors flex items-center gap-2 font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 ${
      isSelected
        ? `${baseColor} ${textColor} ring-2 ${ringColor} shadow-md`
        : `${baseColor} ${textColor} ${hoverColor} ${ringColor}`
    }`;
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Linking Button */}
      <button
        onClick={() => onMotivationChange('linking')}
        className={getButtonClass(
          'linking',
          'bg-blue-100 dark:bg-blue-900/30',
          'hover:bg-blue-200 dark:hover:bg-blue-900/50',
          'text-blue-700 dark:text-blue-300',
          'focus:ring-blue-500'
        )}
        title={t('linking')}
        aria-pressed={selectedMotivation === 'linking'}
      >
        <span className="text-lg">🔗</span>
        <span>{t('linking')}</span>
      </button>

      {/* Highlighting Button */}
      <button
        onClick={() => onMotivationChange('highlighting')}
        className={getButtonClass(
          'highlighting',
          'bg-yellow-100 dark:bg-yellow-900/30',
          'hover:bg-yellow-200 dark:hover:bg-yellow-900/50',
          'text-yellow-700 dark:text-yellow-300',
          'focus:ring-yellow-500'
        )}
        title={t('highlighting')}
        aria-pressed={selectedMotivation === 'highlighting'}
      >
        <span className="text-lg">🟡</span>
        <span>{t('highlighting')}</span>
      </button>

      {/* Assessing Button */}
      <button
        onClick={() => onMotivationChange('assessing')}
        className={getButtonClass(
          'assessing',
          'bg-red-100 dark:bg-red-900/30',
          'hover:bg-red-200 dark:hover:bg-red-900/50',
          'text-red-700 dark:text-red-300',
          'focus:ring-red-500'
        )}
        title={t('assessing')}
        aria-pressed={selectedMotivation === 'assessing'}
      >
        <span className="text-lg">🔴</span>
        <span>{t('assessing')}</span>
      </button>

      {/* Commenting Button */}
      <button
        onClick={() => onMotivationChange('commenting')}
        className={getButtonClass(
          'commenting',
          'bg-gray-100 dark:bg-gray-700',
          'hover:bg-gray-200 dark:hover:bg-gray-600',
          'text-gray-700 dark:text-gray-300',
          'focus:ring-gray-500'
        )}
        title={t('commenting')}
        aria-pressed={selectedMotivation === 'commenting'}
      >
        <span className="text-lg">💬</span>
        <span>{t('commenting')}</span>
      </button>

      {/* Separator */}
      <div className="h-8 w-px bg-gray-300 dark:bg-gray-600 mx-2" />

      {/* Delete Button */}
      <button
        onClick={() => onMotivationChange('deleting')}
        className={getButtonClass(
          'deleting',
          'bg-red-100 dark:bg-red-900/30',
          'hover:bg-red-200 dark:hover:bg-red-900/50',
          'text-red-700 dark:text-red-300',
          'focus:ring-red-500'
        )}
        title={t('deleting')}
        aria-pressed={selectedMotivation === 'deleting'}
      >
        <span className="text-lg">🗑️</span>
        <span>{t('deleting')}</span>
      </button>

      {/* JSON-LD Button */}
      <button
        onClick={() => onMotivationChange('jsonld')}
        className={getButtonClass(
          'jsonld',
          'bg-purple-100 dark:bg-purple-900/30',
          'hover:bg-purple-200 dark:hover:bg-purple-900/50',
          'text-purple-700 dark:text-purple-300',
          'focus:ring-purple-500'
        )}
        title={t('jsonld')}
        aria-pressed={selectedMotivation === 'jsonld'}
      >
        <span className="text-lg">📋</span>
        <span>{t('jsonld')}</span>
      </button>
    </div>
  );
}
