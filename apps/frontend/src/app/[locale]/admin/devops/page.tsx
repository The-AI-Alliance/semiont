'use client';

/**
 * DevOps Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (translations, hooks)
 * and delegates rendering to the pure React AdminDevOpsPage component.
 */

import { useTranslations } from 'next-intl';
import {
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';
import { StatusDisplay, Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useToolbar, useLineNumbers } from '@semiont/react-ui';
import { AdminDevOpsPage } from '@semiont/react-ui';

export default function DevOpsPage() {
  const t = useTranslations('AdminDevOps');

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handlePanelToggle = (panel: string | null) => {
    if (panel) togglePanel(panel as any);
  };

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
      onThemeChange={setTheme}
      showLineNumbers={showLineNumbers}
      onLineNumbersToggle={toggleLineNumbers}
      activePanel={activePanel}
      onPanelToggle={handlePanelToggle}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        systemStatus: t('systemStatus'),
        cliOperations: t('cliOperations'),
        cliOperationsDescription: t('cliOperationsDescription'),
        cliTitle: t('cliTitle'),
        cliDescription: t('cliDescription'),
      }}
      StatusDisplay={StatusDisplay}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
