'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';
import { StatusDisplay } from '@/components/StatusDisplay';
import { Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme } from '@semiont/react-ui';
import { useToolbar } from '@semiont/react-ui';
import { useLineNumbers } from '@semiont/react-ui';

// Authentication is handled by middleware.ts
// Only authenticated admins can reach this page

export default function DevOpsPage() {
  const t = useTranslations('AdminDevOps');

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const suggestedFeatures = [
    {
      title: t('systemMonitoring'),
      description: t('systemMonitoringDescription'),
      icon: ChartBarIcon,
      available: t('systemMonitoringCLI')
    },
    {
      title: t('serviceManagement'),
      description: t('serviceManagementDescription'),
      icon: ServerIcon,
      available: t('serviceManagementCLI')
    },
    {
      title: t('deploymentControl'),
      description: t('deploymentControlDescription'),
      icon: CommandLineIcon,
      available: t('deploymentControlCLI')
    },
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {t('subtitle')}
          </p>
        </div>

        {/* System Status */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">{t('systemStatus')}</h2>
          <StatusDisplay />
        </div>

        {/* CLI Operations */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">{t('cliOperations')}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t('cliOperationsDescription')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
          <div className="flex">
            <div className="flex-shrink-0">
              <CommandLineIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300">
                {t('cliTitle')}
              </h3>
              <div className="mt-2 text-xs text-blue-700 dark:text-blue-400">
                <p>
                  {t('cliDescription')}
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
      <div className="flex">
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={setTheme}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={toggleLineNumbers}
        />

        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={togglePanel}
        />
      </div>
    </div>
  );
}
