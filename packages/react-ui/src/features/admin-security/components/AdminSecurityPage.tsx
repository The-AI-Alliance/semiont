/**
 * AdminSecurityPage Component
 *
 * Pure React component for the admin security configuration page.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  ShieldCheckIcon,
  GlobeAltIcon,
  CheckCircleIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';

export interface OAuthProvider {
  name: string;
  clientId?: string;
}

export interface AdminSecurityPageProps {
  // Data props
  providers: OAuthProvider[];
  allowedDomains: string[];
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
    title: string;
    subtitle: string;
    oauthProviders: string;
    oauthProvidersDescription: string;
    clientId: string;
    configured: string;
    noProvidersConfigured: string;
    allowedDomains: string;
    allowedDomainsDescription: string;
    noDomainsConfigured: string;
    configManagementTitle: string;
    configManagementDescription: string;
    configLocalDev: string;
    configCloudDeploy: string;
    configCloudDeployCommand: string;
    configCloudDeployEnd: string;
    configAWS: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function AdminSecurityPage({
  providers,
  allowedDomains,
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
}: AdminSecurityPageProps) {
  return (
    <div className="semiont-page">
      {/* Main Content Area */}
      <div className="semiont-page__content">
        <div className="semiont-page__sections">
          {/* Page Header */}
          <div className="semiont-page__header">
            <h1 className="semiont-page__title">{t.title}</h1>
            <p className="semiont-page__subtitle">
              {t.subtitle}
            </p>
          </div>

          {/* OAuth Providers */}
          <div className="semiont-admin__card">
            <div className="flex items-center mb-4">
              <ShieldCheckIcon className="h-6 w-6 text-blue-600 dark:text-blue-400 mr-3" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t.oauthProviders}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">{t.oauthProvidersDescription}</p>
              </div>
            </div>

            {isLoading ? (
              <div className="animate-pulse space-y-2">
                <div className="h-12 bg-gray-200 dark:bg-gray-700 rounded"></div>
              </div>
            ) : providers.length > 0 ? (
              <div className="space-y-2">
                {providers.map((provider) => (
                  <div key={provider.name} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <div className="flex items-center">
                      <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                      <span className="font-medium text-gray-900 dark:text-white capitalize">
                        {provider.name}
                      </span>
                      {provider.clientId && (
                        <span className="ml-3 text-xs text-gray-500 dark:text-gray-400 font-mono">
                          {t.clientId}: {provider.clientId}
                        </span>
                      )}
                    </div>
                    <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300">
                      {t.configured}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500 dark:text-gray-400 text-sm">
                {t.noProvidersConfigured}
              </div>
            )}
          </div>

          {/* Allowed Domains */}
          <div className="semiont-admin__card">
            <div className="flex items-center mb-4">
              <GlobeAltIcon className="h-6 w-6 text-blue-600 dark:text-blue-400 mr-3" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t.allowedDomains}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">{t.allowedDomainsDescription}</p>
              </div>
            </div>

            {isLoading ? (
              <div className="animate-pulse space-y-2">
                <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-32"></div>
                <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-40"></div>
              </div>
            ) : allowedDomains.length > 0 ? (
              <div className="space-y-2">
                {allowedDomains.map((domain) => (
                  <div key={domain} className="inline-flex items-center px-3 py-1 mr-2 mb-2 text-sm font-medium text-blue-700 bg-blue-100 rounded-full dark:bg-blue-900/20 dark:text-blue-300">
                    @{domain}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500 dark:text-gray-400 text-sm">
                {t.noDomainsConfigured}
              </div>
            )}
          </div>

          {/* Configuration Info */}
          <div className="semiont-admin__info-box">
            <div className="flex">
              <InformationCircleIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
              <div className="ml-3 text-sm">
                <p className="text-blue-800 dark:text-blue-300 font-medium">{t.configManagementTitle}</p>
                <p className="text-blue-700 dark:text-blue-400 mt-1">
                  {t.configManagementDescription}
                </p>
                <ul className="list-disc list-inside text-blue-700 dark:text-blue-400 mt-2 space-y-1">
                  <li>{t.configLocalDev}</li>
                  <li>{t.configCloudDeploy} <code className="px-1 py-0.5 bg-blue-100 dark:bg-blue-800 rounded">{t.configCloudDeployCommand}</code> {t.configCloudDeployEnd}</li>
                  <li>{t.configAWS}</li>
                </ul>
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
