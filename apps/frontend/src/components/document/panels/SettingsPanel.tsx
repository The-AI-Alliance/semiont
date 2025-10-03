'use client';

import React from 'react';
import { buttonStyles } from '@/lib/button-styles';

interface Props {
  isArchived: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onClone: () => void;
  annotateMode: boolean;
  onAnnotateModeToggle: () => void;
}

export function SettingsPanel({
  isArchived,
  onArchive,
  onUnarchive,
  onClone,
  annotateMode,
  onAnnotateModeToggle
}: Props) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Document Settings
      </h3>

      {/* Annotate Mode Toggle */}
      <div>
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Annotate Mode
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={annotateMode}
            onClick={onAnnotateModeToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              annotateMode ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                annotateMode ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {annotateMode ? 'Edit and create annotations' : 'View document in read-only mode'}
        </p>
      </div>

      {/* Clone Button */}
      <div>
        <button
          onClick={onClone}
          className={`${buttonStyles.secondary.base} w-full justify-center`}
        >
          📋 Clone Document
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
              📤 Unarchive Document
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
              📦 Archive Document
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
