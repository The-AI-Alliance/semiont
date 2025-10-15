'use client';

import { notFound } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  TagIcon,
  PlusIcon,
  ExclamationCircleIcon
} from '@heroicons/react/24/outline';
import { api } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { Toolbar } from '@/components/Toolbar';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';

export default function EntityTagsPage() {
  const t = useTranslations('ModerateEntityTags');
  const { data: session, status } = useSession();
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // Query entity types
  const { data: entityTypesData, isLoading } = api.entityTypes.all.useQuery();
  const entityTypes = entityTypesData?.entityTypes || [];

  // Mutation for creating new entity type
  const createEntityTypeMutation = api.entityTypes.create.useMutation();

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
      // Invalidate the entity types query to refetch
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
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('pageTitle')}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {t('pageDescription')}
          </p>
        </div>

        {/* Entity Tags Management */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start mb-6">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/20 mr-3">
              <TagIcon className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('sectionTitle')}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t('sectionDescription')}
              </p>
            </div>
          </div>

          {/* Existing tags */}
          <div className="mb-6">
            <div className="flex flex-wrap gap-2">
              {entityTypes.map((tag: string) => (
                <span
                  key={tag}
                  className="px-3 py-1 rounded-md text-sm border bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* Add new tag */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
              placeholder={t('inputPlaceholder')}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
              disabled={createEntityTypeMutation.isPending}
            />
            <button
              onClick={handleAddTag}
              disabled={createEntityTypeMutation.isPending || !newTag.trim()}
              className="px-4 py-2 rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors bg-blue-600 hover:bg-blue-700 text-white"
            >
              {createEntityTypeMutation.isPending ? (
                t('adding')
              ) : (
                <>
                  <PlusIcon className="w-5 h-5 inline-block mr-1" />
                  {t('addTag')}
                </>
              )}
            </button>
          </div>

          {/* Error message */}
          {error && (
            <div className="mt-3 flex items-center text-red-600 dark:text-red-400 text-sm">
              <ExclamationCircleIcon className="w-4 h-4 mr-1" />
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="flex">
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={setTheme}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={toggleLineNumbers}
        />

        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={togglePanel}
        />
      </div>
    </div>
  );
}
