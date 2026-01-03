'use client';

import React, { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  ShieldCheckIcon,
  GlobeAltIcon,
  CheckCircleIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';
import { useSession } from 'next-auth/react';
import { useAdmin } from '@semiont/react-ui';
import type { components, paths } from '@semiont/api-client';
import { Toolbar } from '@semiont/react-ui';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type OAuthProvider = ResponseContent<paths['/api/admin/oauth/config']['get']>['providers'][number];
type OAuthConfigResponse = ResponseContent<paths['/api/admin/oauth/config']['get']>;
import { ToolbarPanels } from '@semiont/react-ui';
import { useTheme } from '@semiont/react-ui';
import { useToolbar } from '@semiont/react-ui';
import { useLineNumbers } from '@semiont/react-ui';

export default function AdminSecurity() {
  const t = useTranslations('AdminSecurity');
  const { data: session } = useSession();

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // Get OAuth configuration from API - only run when authenticated
  const adminAPI = useAdmin();
  const { data: oauthConfig, isLoading: oauthLoading } = adminAPI.oauth.config.useQuery();

  const allowedDomains = (oauthConfig as OAuthConfigResponse | undefined)?.allowedDomains ?? [];
  const providers = (oauthConfig as OAuthConfigResponse | undefined)?.providers ?? [];

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        <div className="space-y-6">
          {/* Page Header */}
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {t('subtitle')}
            </p>
          </div>

          {/* OAuth Providers */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center mb-4">
              <ShieldCheckIcon className="h-6 w-6 text-blue-600 dark:text-blue-400 mr-3" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('oauthProviders')}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('oauthProvidersDescription')}</p>
              </div>
            </div>

            {oauthLoading ? (
              <div className="animate-pulse space-y-2">
                <div className="h-12 bg-gray-200 dark:bg-gray-700 rounded"></div>
              </div>
            ) : providers.length > 0 ? (
              <div className="space-y-2">
                {providers.map((provider: OAuthProvider) => (
                  <div key={provider.name} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <div className="flex items-center">
                      <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                      <span className="font-medium text-gray-900 dark:text-white capitalize">
                        {provider.name}
                      </span>
                      {provider.clientId && (
                        <span className="ml-3 text-xs text-gray-500 dark:text-gray-400 font-mono">
                          {t('clientId')}: {provider.clientId}
                        </span>
                      )}
                    </div>
                    <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300">
                      {t('configured')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500 dark:text-gray-400 text-sm">
                {t('noProvidersConfigured')}
              </div>
            )}
          </div>

          {/* Allowed Domains */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center mb-4">
              <GlobeAltIcon className="h-6 w-6 text-blue-600 dark:text-blue-400 mr-3" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('allowedDomains')}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('allowedDomainsDescription')}</p>
              </div>
            </div>

            {oauthLoading ? (
              <div className="animate-pulse space-y-2">
                <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-32"></div>
                <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-40"></div>
              </div>
            ) : allowedDomains.length > 0 ? (
              <div className="space-y-2">
                {allowedDomains.map((domain: string) => (
                  <div key={domain} className="inline-flex items-center px-3 py-1 mr-2 mb-2 text-sm font-medium text-blue-700 bg-blue-100 rounded-full dark:bg-blue-900/20 dark:text-blue-300">
                    @{domain}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500 dark:text-gray-400 text-sm">
                {t('noDomainsConfigured')}
              </div>
            )}
          </div>

          {/* Configuration Info */}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
            <div className="flex">
              <InformationCircleIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
              <div className="ml-3 text-sm">
                <p className="text-blue-800 dark:text-blue-300 font-medium">{t('configManagementTitle')}</p>
                <p className="text-blue-700 dark:text-blue-400 mt-1">
                  {t('configManagementDescription')}
                </p>
                <ul className="list-disc list-inside text-blue-700 dark:text-blue-400 mt-2 space-y-1">
                  <li>{t('configLocalDev')}</li>
                  <li>{t('configCloudDeploy')} <code className="px-1 py-0.5 bg-blue-100 dark:bg-blue-800 rounded">{t('configCloudDeployCommand')}</code> {t('configCloudDeployEnd')}</li>
                  <li>{t('configAWS')}</li>
                </ul>
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
