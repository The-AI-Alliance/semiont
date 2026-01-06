'use client';

/**
 * Entity Tags Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (session, translations, API calls)
 * and delegates rendering to the pure React EntityTagsPage component.
 */

import { notFound } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useEntityTypes, Toolbar } from '@semiont/react-ui';
import { useQueryClient } from '@tanstack/react-query';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useToolbar, useLineNumbers } from '@semiont/react-ui';
import { EntityTagsPage } from '@semiont/react-ui';

export default function EntityTagsPageWrapper() {
  const t = useTranslations('ModerateEntityTags');
  const { data: session, status } = useSession();
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handlePanelToggle = (panel: string | null) => {
    if (panel) togglePanel(panel as any);
  };

  // API hooks
  const entityTypesAPI = useEntityTypes();

  // Query entity types with auto-refetch for cross-browser updates
  const { data: entityTypesData, isLoading } = entityTypesAPI.list.useQuery({
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  });
  const entityTypes = entityTypesData?.entityTypes || [];

  // Mutation for creating new entity type
  const createEntityTypeMutation = entityTypesAPI.add.useMutation();

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

  const handleAddTag = async () => {
    if (!newTag.trim()) return;

    setError('');

    try {
      await createEntityTypeMutation.mutateAsync(newTag.trim());
      queryClient.invalidateQueries({ queryKey: ['/api/entity-types'] });
      setNewTag('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorFailedToAdd'));
    }
  };

  // Show loading while checking session
  if (status === 'loading' || isLoading) {
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
    <EntityTagsPage
      entityTypes={entityTypes as string[]}
      isLoading={isLoading}
      error={error}
      newTag={newTag}
      onNewTagChange={setNewTag}
      onAddTag={handleAddTag}
      isAddingTag={createEntityTypeMutation.isPending}
      theme={theme}
      onThemeChange={setTheme}
      showLineNumbers={showLineNumbers}
      onLineNumbersToggle={toggleLineNumbers}
      activePanel={activePanel}
      onPanelToggle={handlePanelToggle}
      translations={{
        pageTitle: t('pageTitle'),
        pageDescription: t('pageDescription'),
        sectionTitle: t('sectionTitle'),
        sectionDescription: t('sectionDescription'),
        inputPlaceholder: t('inputPlaceholder'),
        addTag: t('addTag'),
        adding: t('adding'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
