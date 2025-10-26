'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { buttonStyles } from '@/lib/button-styles';

interface Props {
  isArchived: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onClone: () => void;
}

export function DocumentPanel({
  isArchived,
  onArchive,
  onUnarchive,
  onClone
}: Props) {
  const t = useTranslations('DocumentPanel');

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        {t('title')}
      </h3>

      {/* Clone Button */}
      <div>
        <button
          onClick={onClone}
          className={`${buttonStyles.secondary.base} w-full justify-center`}
        >
          📋 {t('clone')}
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('cloneDescription')}
        </p>
      </div>

      {/* Archive/Unarchive Button */}
      <div>
        {isArchived ? (
          <>
            <button
              onClick={onUnarchive}
              className={`${buttonStyles.secondary.base} w-full justify-center`}
            >
              📤 {t('unarchive')}
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('unarchiveDescription')}
            </p>
          </>
        ) : (
          <>
            <button
              onClick={onArchive}
              className="w-full px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 justify-center bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              📦 {t('archive')}
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('archiveDescription')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
