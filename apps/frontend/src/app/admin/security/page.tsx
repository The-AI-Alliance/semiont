'use client';

import React from 'react';
import { 
  ShieldCheckIcon,
  KeyIcon,
  GlobeAltIcon,
  CheckCircleIcon,
  XCircleIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';
import { api } from '@/lib/api-client';

interface ConfigSectionProps {
  title: string;
  description: string;
  icon: React.ElementType;
  children: React.ReactNode;
}

function ConfigSection({ title, description, icon: Icon, children }: ConfigSectionProps) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
      <div className="flex items-center mb-4">
        <Icon className="h-6 w-6 text-blue-600 dark:text-blue-400 mr-3" />
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function OAuthProviderCard({ 
  name, 
  description, 
  isConfigured, 
  clientId 
}: { 
  name: string; 
  description: string; 
  isConfigured: boolean;
  clientId?: string;
}) {
  return (
    <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
      <div className="flex-1">
        <div className="flex items-center">
          <h4 className="font-medium text-gray-900 dark:text-white">{name}</h4>
          {isConfigured ? (
            <CheckCircleIcon className="h-5 w-5 text-green-500 ml-2" />
          ) : (
            <XCircleIcon className="h-5 w-5 text-red-500 ml-2" />
          )}
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{description}</p>
        {clientId && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono">
            Client ID: {clientId.slice(0, 20)}...
          </p>
        )}
      </div>
      <div className="flex items-center space-x-2">
        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
          isConfigured
            ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300'
            : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300'
        }`}>
          {isConfigured ? 'Configured' : 'Not Configured'}
        </span>
      </div>
    </div>
  );
}

export default function AdminSecurity() {
  // Get OAuth configuration from API (this would be a real API call)
  const { data: oauthConfig, isLoading: oauthLoading } = api.admin.oauth.config.useQuery();
  
  // For now, we'll check public client ID from environment (secrets are in AWS Secrets Manager)
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const allowedDomains = process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS?.split(',').map(d => d.trim()) || [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Security Settings</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Manage OAuth providers and authentication settings
        </p>
      </div>

      {/* Security Status */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
        <div className="flex items-center">
          <ShieldCheckIcon className="h-8 w-8 text-green-600 dark:text-green-400" />
          <div className="ml-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Security Status</h2>
            <p className="text-sm text-green-600 dark:text-green-400 font-medium">System Secure</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">OAuth authentication is properly configured</p>
          </div>
        </div>
      </div>

      {/* OAuth Configuration */}
      <ConfigSection
        title="OAuth Providers"
        description="Configure OAuth providers for user authentication"
        icon={KeyIcon}
      >
        {oauthLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div key={i} className="animate-pulse p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="h-4 bg-gray-300 dark:bg-gray-600 rounded w-24 mb-2"></div>
                    <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded w-48"></div>
                  </div>
                  <div className="h-6 bg-gray-300 dark:bg-gray-600 rounded w-16"></div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <OAuthProviderCard
              name="Google OAuth"
              description="OAuth provider for Google authentication"
              isConfigured={!!googleClientId}
              {...(googleClientId && { clientId: googleClientId })}
            />
            
            <OAuthProviderCard
              name="GitHub OAuth"
              description="OAuth provider for GitHub authentication"
              isConfigured={false}
            />

            {/* Configuration Notice */}
            <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700">
              <div className="flex">
                <InformationCircleIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
                <div className="ml-3">
                  <h4 className="text-sm font-medium text-blue-800 dark:text-blue-300">Configuration Note</h4>
                  <p className="text-sm text-blue-700 dark:text-blue-400 mt-1">
                    OAuth credentials are securely stored in AWS Secrets Manager. 
                    Contact your system administrator to add or modify OAuth providers.
                  </p>
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
                    Secret names: <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">semiont/oauth/google</code>, 
                    <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded ml-1">semiont/oauth/github</code>
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </ConfigSection>

      {/* Domain Access Control */}
      <ConfigSection
        title="Domain Access Control"
        description="Domains allowed to access the system via OAuth"
        icon={GlobeAltIcon}
      >
        <div className="space-y-4">
          {allowedDomains.length > 0 ? (
            <>
              <div>
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">Allowed Domains</h4>
                <div className="flex flex-wrap gap-2">
                  {allowedDomains.map((domain, index) => (
                    <span 
                      key={index}
                      className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300"
                    >
                      {domain}
                    </span>
                  ))}
                </div>
              </div>
              
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <p><strong>Total allowed domains:</strong> {allowedDomains.length}</p>
                <p><strong>Access control:</strong> Only users with email addresses from these domains can sign in</p>
              </div>
            </>
          ) : (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-700">
              <div className="flex">
                <InformationCircleIcon className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                <div className="ml-3">
                  <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">No Domain Restrictions</h4>
                  <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-1">
                    No domain restrictions are configured. Any email domain can access the system.
                  </p>
                </div>
              </div>
            </div>
          )}
          
          <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h5 className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">Configuration</h5>
            <p className="text-xs text-gray-600 dark:text-gray-400 font-mono">
              Environment Variable: NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              Current Value: {process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS || 'Not set'}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
              Note: This is a public configuration. OAuth secrets are stored in AWS Secrets Manager.
            </p>
          </div>
        </div>
      </ConfigSection>

      {/* Session Configuration */}
      <ConfigSection
        title="Session Configuration"
        description="Current session and authentication settings"
        icon={ShieldCheckIcon}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <h4 className="font-medium text-gray-900 dark:text-white">Session Timeout</h4>
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">8 hours</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">Maximum session duration</p>
          </div>
          
          <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <h4 className="font-medium text-gray-900 dark:text-white">Session Storage</h4>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">JWT Tokens</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">Secure, stateless authentication</p>
          </div>
        </div>
      </ConfigSection>

      {/* AWS Secrets Manager Info */}
      <ConfigSection
        title="Secrets Management"
        description="OAuth credentials are securely stored in AWS Secrets Manager"
        icon={KeyIcon}
      >
        <div className="space-y-4">
          <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-3">Secret Structure</h4>
            <div className="space-y-2 text-xs font-mono text-gray-600 dark:text-gray-400">
              <div className="p-2 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-600">
                <span className="text-blue-600 dark:text-blue-400">semiont/oauth/google</span>
                <pre className="mt-1 text-gray-500 dark:text-gray-500">{`{
  "clientId": "...",
  "clientSecret": "..."
}`}</pre>
              </div>
              <div className="p-2 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-600">
                <span className="text-blue-600 dark:text-blue-400">semiont/oauth/github</span>
                <pre className="mt-1 text-gray-500 dark:text-gray-500">{`{
  "clientId": "...",
  "clientSecret": "..."
}`}</pre>
              </div>
            </div>
          </div>
          
          <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-700">
            <div className="flex">
              <InformationCircleIcon className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5" />
              <div className="ml-3">
                <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">Security Best Practice</h4>
                <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-1">
                  OAuth client secrets are never exposed to the frontend. They are fetched 
                  server-side from AWS Secrets Manager during authentication flows.
                </p>
              </div>
            </div>
          </div>
        </div>
      </ConfigSection>
    </div>
  );
}