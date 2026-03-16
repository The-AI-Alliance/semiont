'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, usePanelBrowse, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { RecentDocumentsPage } from '@semiont/react-ui';

// Authentication is handled by middleware (proxy.ts)
// Only authenticated moderators/admins can reach this page

export default function RecentDocumentsPageWrapper() {
  const t = useTranslations('ModerateRecent');

  // Toolbar and settings state
  const { activePanel } = usePanelBrowse();
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
    <RecentDocumentsPage
      hasDocuments={false}
      isLoading={false}
      theme={theme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
      translations={{
        pageTitle: t('pageTitle'),
        pageDescription: t('pageDescription'),
        sectionTitle: t('sectionTitle'),
        sectionDescription: t('sectionDescription'),
        noDocuments: t('noDocuments'),
        activityWillAppear: t('activityWillAppear'),
        loading: t('loading'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
