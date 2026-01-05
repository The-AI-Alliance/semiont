/**
 * TagSchemasPage Component
 *
 * Pure React component for viewing tag schemas.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  BookOpenIcon,
  AcademicCapIcon,
  ScaleIcon,
  LightBulbIcon
} from '@heroicons/react/24/outline';

export interface TagCategory {
  name: string;
  description: string;
  examples: string[];
}

export interface TagSchema {
  id: string;
  name: string;
  description: string;
  domain: 'legal' | 'scientific' | 'general';
  tags: TagCategory[];
}

export interface TagSchemasPageProps {
  // Data props
  schemas: TagSchema[];
  isLoading: boolean;

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
    categories: string;
    loading: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

const domainIcons: Record<string, React.ComponentType<any>> = {
  legal: ScaleIcon,
  scientific: AcademicCapIcon,
  general: LightBulbIcon
};

const domainColors = {
  legal: {
    bg: 'bg-purple-100 dark:bg-purple-900/20',
    text: 'text-purple-600 dark:text-purple-400',
    border: 'border-purple-200 dark:border-purple-800'
  },
  scientific: {
    bg: 'bg-green-100 dark:bg-green-900/20',
    text: 'text-green-600 dark:text-green-400',
    border: 'border-green-200 dark:border-green-800'
  },
  general: {
    bg: 'bg-orange-100 dark:bg-orange-900/20',
    text: 'text-orange-600 dark:text-orange-400',
    border: 'border-orange-200 dark:border-orange-800'
  }
};

export function TagSchemasPage({
  schemas,
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
}: TagSchemasPageProps) {
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

        {/* Schemas Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {schemas.map((schema) => {
            const Icon = domainIcons[schema.domain];
            const colors = domainColors[schema.domain];

            return (
              <div
                key={schema.id}
                className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6"
              >
                {/* Schema Header */}
                <div className="flex items-start mb-4">
                  <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${colors.bg} mr-3`}>
                    <Icon className={`w-6 h-6 ${colors.text}`} />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{schema.name}</h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                      {schema.description}
                    </p>
                    <span className={`inline-block mt-2 px-2 py-1 text-xs rounded-md ${colors.bg} ${colors.text} border ${colors.border}`}>
                      {schema.domain}
                    </span>
                  </div>
                </div>

                {/* Categories */}
                <div className="space-y-3 mt-4">
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {t.categories}
                  </h4>
                  {schema.tags.map((tag) => (
                    <div
                      key={tag.name}
                      className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 border border-gray-200 dark:border-gray-700"
                    >
                      <div className="font-medium text-gray-900 dark:text-white text-sm mb-1">
                        {tag.name}
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                        {tag.description}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {tag.examples.slice(0, 2).map((example, idx) => (
                          <span
                            key={idx}
                            className="inline-block px-2 py-0.5 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                          >
                            {example}
                          </span>
                        ))}
                        {tag.examples.length > 2 && (
                          <span className="inline-block px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">
                            +{tag.examples.length - 2} more
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
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
