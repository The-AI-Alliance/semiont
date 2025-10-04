'use client';

import React from 'react';
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
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Document Actions
      </h3>

      {/* Clone Button */}
      <div>
        <button
          onClick={onClone}
          className={`${buttonStyles.secondary.base} w-full justify-center`}
        >
          📋 Clone
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Create a copy of this document
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
              📤 Unarchive
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Restore this document to active status
            </p>
          </>
        ) : (
          <>
            <button
              onClick={onArchive}
              className="w-full px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 justify-center bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              📦 Archive
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Move this document to archived status
            </p>
          </>
        )}
      </div>
    </div>
  );
}
