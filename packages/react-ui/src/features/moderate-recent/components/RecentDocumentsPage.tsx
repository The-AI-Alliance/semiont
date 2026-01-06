/**
 * RecentDocumentsPage Component
 *
 * Pure React component for viewing recent documents.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import { ClockIcon } from '@heroicons/react/24/outline';

export interface RecentDocumentsPageProps {
  // Data props
  hasDocuments: boolean;
  isLoading: boolean;

  // UI state
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  activePanel: string | null;
  onPanelToggle: (panel: string | null) => void;

  // Translations
  translations: {
    pageTitle: string;
    pageDescription: string;
    sectionTitle: string;
    sectionDescription: string;
    noDocuments: string;
    activityWillAppear: string;
    loading: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function RecentDocumentsPage({
  hasDocuments,
  isLoading,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  activePanel,
  onPanelToggle,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: RecentDocumentsPageProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t.loading}</p>
      </div>
    );
  }

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

        {/* Recent Documents Section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start mb-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-900/20 mr-3">
              <ClockIcon className="w-6 h-6 text-gray-600 dark:text-gray-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t.sectionTitle}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t.sectionDescription}
              </p>
            </div>
          </div>

          <div className="text-center py-12">
            <svg className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">{t.noDocuments}</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              {t.activityWillAppear}
            </p>
          </div>
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
