/**
 * DevOps Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (translations, hooks)
 * and delegates rendering to the pure React AdminDevOpsPage component.
 */

import { useTranslation } from 'react-i18next';
import { useEffect, useCallback } from 'react';
import {
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';
import { StatusDisplay, Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useBrowseVM, useObservable, useLineNumbers, useEventSubscriptions, useKnowledgeBaseSession } from '@semiont/react-ui';
import { AdminDevOpsPage } from '@semiont/react-ui';

// Wrapper component that provides auth props to StatusDisplay
function StatusDisplayWithAuth() {
  const { isFullyAuthenticated, isAuthenticated, hasValidBackendToken } = useKnowledgeBaseSession();
  return (
    <StatusDisplay
      isFullyAuthenticated={isFullyAuthenticated}
      isAuthenticated={isAuthenticated}
      hasValidBackendToken={hasValidBackendToken}
    />
  );
}

export default function DevOpsPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminDevOps.${k}`, p as any) as string;

  // Toolbar and settings state
  const browseVM = useBrowseVM();
  const activePanel = useObservable(browseVM.activePanel$) ?? null;
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

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
    <AdminDevOpsPage
      suggestedFeatures={suggestedFeatures}
      theme={theme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        systemStatus: t('systemStatus'),
        cliOperations: t('cliOperations'),
        cliOperationsDescription: t('cliOperationsDescription'),
        cliTitle: t('cliTitle'),
        cliDescription: t('cliDescription'),
      }}
      StatusDisplay={StatusDisplayWithAuth}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
