/**
 * Admin Security Client - Thin Next.js wrapper
 *
 * This component handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React AdminSecurityPage component.
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Toolbar, useSemiont } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useShellStateUnit, useObservable, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { AdminSecurityPage } from '@semiont/react-ui';
import type { OAuthProvider } from '@semiont/react-ui';
import { createAdminSecurityStateUnit } from '@semiont/react-ui';
import { useStateUnit } from '@semiont/react-ui';

export default function AdminSecurity() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminSecurity.${k}`, p as any) as string;

  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const browseStateUnit = useShellStateUnit();
  const stateUnit = useStateUnit(() => createAdminSecurityStateUnit(semiont!, browseStateUnit));

  const activePanel = useObservable(stateUnit.browse.activePanel$) ?? null;
  const providers = useObservable(stateUnit.providers$) ?? [];
  const allowedDomains = useObservable(stateUnit.allowedDomains$) ?? [];
  const isLoading = useObservable(stateUnit.isLoading$) ?? true;

  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handleThemeChanged = useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => {
    setTheme(theme);
  }, [setTheme]);

  const handleLineNumbersToggled = useCallback(() => {
    toggleLineNumbers();
  }, [toggleLineNumbers]);

  useEventSubscriptions({
    'settings:theme-changed': handleThemeChanged,
    'settings:line-numbers-toggled': handleLineNumbersToggled,
  });

  return (
    <AdminSecurityPage
      providers={providers as OAuthProvider[]}
      allowedDomains={allowedDomains}
      isLoading={isLoading}
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
