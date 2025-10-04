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
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
}

export function SettingsPanel({
  isArchived,
  onArchive,
  onUnarchive,
  onClone,
  annotateMode,
  onAnnotateModeToggle,
  showLineNumbers,
  onLineNumbersToggle,
  theme,
  onThemeChange
}: Props) {
  return (
    <div className="space-y-6">
      {/* User Settings Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
          User Settings
        </h3>

        <div className="space-y-4">
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

          {/* Line Numbers Toggle */}
          <div>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Line Numbers
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={showLineNumbers}
                onClick={onLineNumbersToggle}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  showLineNumbers ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                    showLineNumbers ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {showLineNumbers ? 'Line numbers visible' : 'Line numbers hidden'}
            </p>
          </div>

          {/* Theme Selection */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">
              Theme
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => onThemeChange('light')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'light'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                ☀️ Light
              </button>
              <button
                onClick={() => onThemeChange('dark')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'dark'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                🌙 Dark
              </button>
              <button
                onClick={() => onThemeChange('system')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'system'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                💻 System
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {theme === 'system' ? 'Using system preference' : `${theme.charAt(0).toUpperCase() + theme.slice(1)} mode active`}
            </p>
          </div>
        </div>
      </div>

      {/* Document Settings Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
          Document Settings
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
    </div>
  );
}
