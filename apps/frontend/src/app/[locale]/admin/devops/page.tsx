'use client';

/**
 * DevOps Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (translations, hooks)
 * and delegates rendering to the pure React AdminDevOpsPage component.
 */

import { useTranslations } from 'next-intl';
import { useEffect, useCallback } from 'react';
import {
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';
import { StatusDisplay, Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, usePanelNavigation, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { AdminDevOpsPage } from '@semiont/react-ui';
import { useAuth } from '@/hooks/useAuth';

// Wrapper component that provides auth props to StatusDisplay
function StatusDisplayWithAuth() {
  const { isFullyAuthenticated, isAuthenticated, hasValidBackendToken } = useAuth();
  return (
    <StatusDisplay
      isFullyAuthenticated={isFullyAuthenticated}
      isAuthenticated={isAuthenticated}
      hasValidBackendToken={hasValidBackendToken}
    />
  );
}

export default function DevOpsPage() {
  const t = useTranslations('AdminDevOps');

  // Toolbar and settings state
  const { activePanel } = usePanelNavigation();
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
