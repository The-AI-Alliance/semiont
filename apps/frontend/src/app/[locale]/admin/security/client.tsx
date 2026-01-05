'use client';

/**
 * Admin Security Client - Thin Next.js wrapper
 *
 * This component handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React AdminSecurityPage component.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { useAdmin, Toolbar } from '@semiont/react-ui';
import type { paths } from '@semiont/api-client';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useToolbar, useLineNumbers } from '@semiont/react-ui';
import { AdminSecurityPage } from '@/features/admin-security/components/AdminSecurityPage';
import type { OAuthProvider } from '@/features/admin-security/components/AdminSecurityPage';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type OAuthConfigResponse = ResponseContent<paths['/api/admin/oauth/config']['get']>;

export default function AdminSecurity() {
  const t = useTranslations('AdminSecurity');

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handlePanelToggle = (panel: string | null) => {
    if (panel) togglePanel(panel as any);
  };

  // Get OAuth configuration from API
  const adminAPI = useAdmin();
  const { data: oauthConfig, isLoading: oauthLoading } = adminAPI.oauth.config.useQuery();

  const allowedDomains = (oauthConfig as OAuthConfigResponse | undefined)?.allowedDomains ?? [];
  const providers = (oauthConfig as OAuthConfigResponse | undefined)?.providers ?? [];

  return (
    <AdminSecurityPage
      providers={providers as OAuthProvider[]}
      allowedDomains={allowedDomains}
      isLoading={oauthLoading}
      theme={theme}
      onThemeChange={setTheme}
      showLineNumbers={showLineNumbers}
      onLineNumbersToggle={toggleLineNumbers}
      activePanel={activePanel}
      onPanelToggle={handlePanelToggle}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        oauthProviders: t('oauthProviders'),
        oauthProvidersDescription: t('oauthProvidersDescription'),
        clientId: t('clientId'),
        configured: t('configured'),
        noProvidersConfigured: t('noProvidersConfigured'),
        allowedDomains: t('allowedDomains'),
        allowedDomainsDescription: t('allowedDomainsDescription'),
        noDomainsConfigured: t('noDomainsConfigured'),
        configManagementTitle: t('configManagementTitle'),
        configManagementDescription: t('configManagementDescription'),
        configLocalDev: t('configLocalDev'),
        configCloudDeploy: t('configCloudDeploy'),
        configCloudDeployCommand: t('configCloudDeployCommand'),
        configCloudDeployEnd: t('configCloudDeployEnd'),
        configAWS: t('configAWS'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
