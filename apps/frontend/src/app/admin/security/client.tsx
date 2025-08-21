'use client';

import React from 'react';
import { 
  ShieldCheckIcon,
  GlobeAltIcon,
  CheckCircleIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';
import { api } from '@/lib/api-client';
import { useSecureAPI } from '@/hooks/useSecureAPI';

export default function AdminSecurity() {
  // Ensure API client has authentication token
  const { hasValidToken } = useSecureAPI();
  
  // Get OAuth configuration from API - only run when authenticated
  const { data: oauthConfig, isLoading: oauthLoading } = api.admin.oauth.config.useQuery(
    { enabled: hasValidToken }
  );
  
  const allowedDomains = (oauthConfig as any)?.allowedDomains || [];
  const providers = (oauthConfig as any)?.providers || [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">OAuth Configuration</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          View OAuth providers and allowed domains
        </p>
      </div>

      {/* OAuth Providers */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
        <div className="flex items-center mb-4">
          <ShieldCheckIcon className="h-6 w-6 text-blue-600 dark:text-blue-400 mr-3" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">OAuth Providers</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">Configured authentication providers</p>
          </div>
        </div>
        
        {oauthLoading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-12 bg-gray-200 dark:bg-gray-700 rounded"></div>
          </div>
        ) : providers.length > 0 ? (
          <div className="space-y-2">
            {providers.map((provider: any) => (
              <div key={provider.name} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                <div className="flex items-center">
                  <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                  <span className="font-medium text-gray-900 dark:text-white capitalize">
                    {provider.name}
                  </span>
                  {provider.clientId && (
                    <span className="ml-3 text-xs text-gray-500 dark:text-gray-400 font-mono">
                      Client ID: {provider.clientId}
                    </span>
                  )}
                </div>
                <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300">
                  Configured
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-gray-500 dark:text-gray-400 text-sm">
            No OAuth providers configured
          </div>
        )}
      </div>

      {/* Allowed Domains */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
        <div className="flex items-center mb-4">
          <GlobeAltIcon className="h-6 w-6 text-blue-600 dark:text-blue-400 mr-3" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Allowed Email Domains</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">Users from these domains can sign in</p>
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
            No domains configured - authentication is disabled
          </div>
        )}
      </div>

      {/* Configuration Info */}
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
        <div className="flex">
          <InformationCircleIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
          <div className="ml-3 text-sm">
            <p className="text-blue-800 dark:text-blue-300 font-medium">Configuration Management</p>
            <p className="text-blue-700 dark:text-blue-400 mt-1">
              OAuth settings are managed through environment variables. To modify these settings:
            </p>
            <ul className="list-disc list-inside text-blue-700 dark:text-blue-400 mt-2 space-y-1">
              <li>For local development: Update your .env files</li>
              <li>For cloud deployments: Use <code className="px-1 py-0.5 bg-blue-100 dark:bg-blue-800 rounded">semiont update -e &lt;environment&gt;</code> to apply changes from config files</li>
              <li>For AWS: Settings are stored in AWS Secrets Manager and ECS task definitions</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}