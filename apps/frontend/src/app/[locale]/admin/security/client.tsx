/**
 * Admin Security Client - Thin Next.js wrapper
 *
 * This component handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React AdminSecurityPage component.
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Toolbar, useApiClient } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useBrowseVM, useObservable, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { AdminSecurityPage } from '@semiont/react-ui';
import type { OAuthProvider } from '@semiont/react-ui';
import { createAdminSecurityPageVM } from '@semiont/react-ui';
import { useViewModel } from '@semiont/react-ui';

export default function AdminSecurity() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminSecurity.${k}`, p as any) as string;

  const semiont = useApiClient();
  const browseVM = useBrowseVM();
  const vm = useViewModel(() => createAdminSecurityPageVM(semiont!, browseVM));

  const activePanel = useObservable(vm.browse.activePanel$) ?? null;
  const providers = useObservable(vm.providers$) ?? [];
  const allowedDomains = useObservable(vm.allowedDomains$) ?? [];
  const isLoading = useObservable(vm.isLoading$) ?? true;

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
