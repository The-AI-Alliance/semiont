/**
 * Admin Security Client - Thin Next.js wrapper
 *
 * This component handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React AdminSecurityPage component.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Toolbar, useApiClient, useAuthToken } from '@semiont/react-ui';
import type { paths } from '@semiont/core';
import { accessToken } from '@semiont/core';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useBrowseVM, useObservable, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { AdminSecurityPage } from '@semiont/react-ui';
import type { OAuthProvider } from '@semiont/react-ui';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type OAuthConfigResponse = ResponseContent<paths['/api/admin/oauth/config']['get']>;

export default function AdminSecurity() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminSecurity.${k}`, p as any) as string;

  // Toolbar and settings state
  const browseVM = useBrowseVM();
  const activePanel = useObservable(browseVM.activePanel$) ?? null;
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const semiont = useApiClient();
  const token = useAuthToken();

  // Handle theme change events
  const handleThemeChanged = useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => {
    setTheme(theme);
  }, [setTheme]);

  // Handle line numbers toggle events
  const handleLineNumbersToggled = useCallback(() => {
    toggleLineNumbers();
  }, [toggleLineNumbers]);

  useEventSubscriptions({
    'settings:theme-changed': handleThemeChanged,
    'settings:line-numbers-toggled': handleLineNumbersToggled,
  });

  const [oauthConfig, setOauthConfig] = useState<OAuthConfigResponse | undefined>(undefined);
  const [oauthLoading, setOauthLoading] = useState(true);

  useEffect(() => {
    if (!semiont) return;
    semiont.getOAuthConfig(token ? { auth: accessToken(token) } : {})
      .then((data) => { setOauthConfig(data as OAuthConfigResponse); setOauthLoading(false); })
      .catch(() => setOauthLoading(false));
  }, [semiont, token]);

  const allowedDomains = oauthConfig?.allowedDomains ?? [];
  const providers = oauthConfig?.providers ?? [];

  return (
    <AdminSecurityPage
      providers={providers as OAuthProvider[]}
      allowedDomains={allowedDomains}
      isLoading={oauthLoading}
      theme={theme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
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
