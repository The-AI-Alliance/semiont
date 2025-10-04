'use client';

import React from 'react';

interface Props {
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
}

export function SettingsPanel({
  showLineNumbers,
  onLineNumbersToggle,
  theme,
  onThemeChange
}: Props) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        User Settings
      </h3>

        <div className="space-y-4">
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
  );
}
