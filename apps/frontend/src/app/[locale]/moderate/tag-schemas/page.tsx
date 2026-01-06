'use client';

import { notFound } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme } from '@semiont/react-ui';
import { useToolbar } from '@semiont/react-ui';
import { useLineNumbers } from '@semiont/react-ui';
import { getAllTagSchemas } from '@semiont/ontology';
import { TagSchemasPage } from '@semiont/react-ui';

export default function TagSchemasPageWrapper() {
  const t = useTranslations('ModerateTagSchemas');
  const { data: session, status } = useSession();

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handlePanelToggle = (panel: string | null) => {
    if (panel) togglePanel(panel as any);
  };

  // Get all tag schemas
  const schemas = getAllTagSchemas();

  // Check authentication and moderator/admin status
  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'unauthenticated') {
      notFound();
    }
    if (!session?.backendUser?.isModerator && !session?.backendUser?.isAdmin) {
      notFound();
    }
  }, [status, session]);

  // Show loading while checking session
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
      </div>
    );
  }

  // Show nothing if not moderator/admin (will be handled by notFound)
  if (!session?.backendUser?.isModerator && !session?.backendUser?.isAdmin) {
    return null;
  }

  return (
    <TagSchemasPage
      schemas={schemas}
      isLoading={false}
      theme={theme}
      onThemeChange={setTheme}
      showLineNumbers={showLineNumbers}
      onLineNumbersToggle={toggleLineNumbers}
      activePanel={activePanel}
      onPanelToggle={handlePanelToggle}
      translations={{
        pageTitle: t('pageTitle'),
        pageDescription: t('pageDescription'),
        categories: t('categories'),
        loading: t('loading'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
