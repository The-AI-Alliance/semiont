/**
 * EntityTagsPage Component
 *
 * Pure React component for managing entity tags.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  TagIcon,
  PlusIcon,
  ExclamationCircleIcon
} from '@heroicons/react/24/outline';

export interface EntityTagsPageProps {
  // Data props
  entityTypes: string[];
  isLoading: boolean;
  error: string;

  // Tag input state
  newTag: string;
  onNewTagChange: (value: string) => void;

  // Actions
  onAddTag: () => void;
  isAddingTag: boolean;

  // UI state
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  activePanel: string | null;
  onPanelToggle: (panel: string) => void;

  // Translations
  translations: {
    pageTitle: string;
    pageDescription: string;
    sectionTitle: string;
    sectionDescription: string;
    inputPlaceholder: string;
    addTag: string;
    adding: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function EntityTagsPage({
  entityTypes,
  isLoading,
  error,
  newTag,
  onNewTagChange,
  onAddTag,
  isAddingTag,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  activePanel,
  onPanelToggle,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: EntityTagsPageProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onAddTag();
    }
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t.pageTitle}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {t.pageDescription}
          </p>
        </div>

        {/* Entity Tags Management */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start mb-6">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/20 mr-3">
              <TagIcon className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t.sectionTitle}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t.sectionDescription}
              </p>
            </div>
          </div>

          {/* Existing tags */}
          <div className="mb-6">
            <div className="flex flex-wrap gap-2">
              {entityTypes.map((tag: string) => (
                <span
                  key={tag}
                  className="px-3 py-1 rounded-md text-sm border bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* Add new tag */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newTag}
              onChange={(e) => onNewTagChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t.inputPlaceholder}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
              disabled={isAddingTag}
            />
            <button
              onClick={onAddTag}
              disabled={isAddingTag || !newTag.trim()}
              className="px-4 py-2 rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors bg-blue-600 hover:bg-blue-700 text-white"
            >
              {isAddingTag ? (
                t.adding
              ) : (
                <>
                  <PlusIcon className="w-5 h-5 inline-block mr-1" />
                  {t.addTag}
                </>
              )}
            </button>
          </div>

          {/* Error message */}
          {error && (
            <div className="mt-3 flex items-center text-red-600 dark:text-red-400 text-sm">
              <ExclamationCircleIcon className="w-4 h-4 mr-1" />
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="flex">
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={onThemeChange}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={onLineNumbersToggle}
        />

        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={onPanelToggle}
        />
      </div>
    </div>
  );
}
