/**
 * AdminDevOpsPage Component
 *
 * Pure React component for the admin devops page.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';

export interface DevOpsFeature {
  title: string;
  description: string;
  icon: React.ComponentType<any>;
  available: string;
}

export interface AdminDevOpsPageProps {
  // Data props
  suggestedFeatures: DevOpsFeature[];

  // UI state
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  activePanel: string | null;
  onPanelToggle: (panel: string | null) => void;

  // Translations
  translations: {
    title: string;
    subtitle: string;
    systemStatus: string;
    cliOperations: string;
    cliOperationsDescription: string;
    cliTitle: string;
    cliDescription: string;
  };

  // Component dependencies
  StatusDisplay: React.ComponentType<any>;
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function AdminDevOpsPage({
  suggestedFeatures,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  activePanel,
  onPanelToggle,
  translations: t,
  StatusDisplay,
  ToolbarPanels,
  Toolbar,
}: AdminDevOpsPageProps) {
  return (
    <div className="semiont-page">
      {/* Main Content Area */}
      <div className="semiont-page__content">
        {/* Page Title */}
        <div className="semiont-page__header">
          <h1 className="semiont-page__title">{t.title}</h1>
          <p className="semiont-page__subtitle">
            {t.subtitle}
          </p>
        </div>

        {/* System Status */}
        <div className="semiont-admin__section">
          <h2 className="semiont-admin__section-title">{t.systemStatus}</h2>
          <StatusDisplay />
        </div>

        {/* CLI Operations */}
        <div className="semiont-admin__section">
          <h2 className="semiont-admin__section-title">{t.cliOperations}</h2>
          <p className="semiont-admin__section-description">
            {t.cliOperationsDescription}
          </p>
          <div className="semiont-admin__features-grid">
            {suggestedFeatures.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg p-6 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-start">
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-200 dark:bg-gray-700">
                    <feature.icon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                  </div>
                  <div className="ml-3 flex-1">
                    <h3 className="text-sm font-medium text-gray-900 dark:text-white">
                      {feature.title}
                    </h3>
                    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                      {feature.description}
                    </p>
                    <p className="mt-2 text-xs font-mono text-blue-600 dark:text-blue-400">
                      {feature.available}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Info Box */}
        <div className="semiont-admin__info-box">
          <div className="flex">
            <div className="flex-shrink-0">
              <CommandLineIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300">
                {t.cliTitle}
              </h3>
              <div className="mt-2 text-xs text-blue-700 dark:text-blue-400">
                <p>
                  {t.cliDescription}
                </p>
                <code className="block mt-2 p-2 bg-blue-100 dark:bg-blue-800/50 rounded">
                  semiont --help
                </code>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="semiont-page__sidebar">
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
