'use client';

import { useState, useCallback } from 'react';
import {
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';
import { StatusDisplay } from '@/components/StatusDisplay';
import { Toolbar } from '@/components/Toolbar';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useTheme } from '@/hooks/useTheme';

// Authentication is handled by middleware.ts
// Only authenticated admins can reach this page

export default function DevOpsPage() {
  // Toolbar and settings state
  const [activeToolbarPanel, setActiveToolbarPanel] = useState<'settings' | null>(null);
  const [showLineNumbers, setShowLineNumbers] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('showLineNumbers') === 'true';
    }
    return false;
  });
  const { theme, setTheme } = useTheme();

  const handleToolbarPanelToggle = useCallback((panel: 'settings') => {
    setActiveToolbarPanel(current => current === panel ? null : panel);
  }, []);

  const handleLineNumbersToggle = useCallback(() => {
    const newMode = !showLineNumbers;
    setShowLineNumbers(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('showLineNumbers', newMode.toString());
    }
  }, [showLineNumbers]);

  const suggestedFeatures = [
    {
      title: 'System Monitoring',
      description: 'Real-time service health, metrics, and logs',
      icon: ChartBarIcon,
      available: 'CLI: semiont check'
    },
    {
      title: 'Service Management',
      description: 'Start, stop, and restart services',
      icon: ServerIcon,
      available: 'CLI: semiont start/stop/restart'
    },
    {
      title: 'Deployment Control',
      description: 'Deploy updates and manage configurations',
      icon: CommandLineIcon,
      available: 'CLI: semiont update'
    },
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">DevOps</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            System monitoring and management operations
          </p>
        </div>

        {/* System Status */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">System Status</h2>
          <StatusDisplay />
        </div>

        {/* CLI Operations */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">CLI Operations</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            These operations are available through the Semiont CLI for enhanced control and automation.
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
                Semiont CLI for Advanced Operations
              </h3>
              <div className="mt-2 text-xs text-blue-700 dark:text-blue-400">
                <p>
                  For infrastructure management, deployments, and monitoring, use the Semiont CLI:
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
        {/* Panels Container */}
        {activeToolbarPanel && (
          <div className="w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 overflow-y-auto p-4">
            {/* Settings Panel */}
            {activeToolbarPanel === 'settings' && (
              <SettingsPanel
                showLineNumbers={showLineNumbers}
                onLineNumbersToggle={handleLineNumbersToggle}
                theme={theme}
                onThemeChange={setTheme}
              />
            )}
          </div>
        )}

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activeToolbarPanel}
          onPanelToggle={handleToolbarPanelToggle}
        />
      </div>
    </div>
  );
}
