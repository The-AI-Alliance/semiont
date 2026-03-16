'use client';

/**
 * Entity Tags Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (translations, API calls)
 * and delegates rendering to the pure React EntityTagsPage component.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useEntityTypes, Toolbar } from '@semiont/react-ui';
import { useQueryClient } from '@tanstack/react-query';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, usePanelBrowse, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { EntityTagsPage } from '@semiont/react-ui';

// Authentication is handled by middleware (proxy.ts)
// Only authenticated moderators/admins can reach this page

export default function EntityTagsPageWrapper() {
  const t = useTranslations('ModerateEntityTags');
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
      </div>
    );
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
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
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
