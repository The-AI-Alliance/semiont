/**
 * DevOps Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (translations, hooks)
 * and delegates rendering to the pure React AdminDevOpsPage component.
 */

import { useTranslation } from 'react-i18next';
import {
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';
import { StatusDisplay, Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useShellStateUnit, useObservable, useSemiont } from '@semiont/react-ui';
import { AdminDevOpsPage } from '@semiont/react-ui';

// Wrapper component that provides auth props to StatusDisplay.
// The three booleans collapse to the same value (is the user authenticated?)
// now that token and user are both session-owned.
function StatusDisplayWithAuth() {
  const session = useObservable(useSemiont().activeSession$);
  const user = useObservable(session?.user$);
  const authed = !!user;
  return (
    <StatusDisplay
      isFullyAuthenticated={authed}
      isAuthenticated={authed}
      hasValidGatewayToken={authed}
    />
  );
}

export default function DevOpsPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminDevOps.${k}`, p as any) as string;

  // Toolbar and settings state
  const browseStateUnit = useShellStateUnit();
  const activePanel = useObservable(browseStateUnit.activePanel$) ?? null;
  const { theme } = useTheme();



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
