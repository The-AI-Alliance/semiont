"use client";

/**
 * Resource Discovery Page - Thin Next.js wrapper
 *
 * Handles Next.js-specific concerns (routing, data loading, hooks) and
 * delegates rendering to the pure React ResourceDiscoveryPage component.
 *
 * Search is wired through createSearchPipeline (pure RxJS): the pipeline is
 * created once per mount and held in useState. The component pushes typed
 * input to setQuery and reads results via useObservable.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';
import {
  useResources,
  useEntityTypes,
  useTheme,
  useBrowseVM,
  useLineNumbers,
  useEventSubscriptions,
  useObservable,
  useApiClient,
  createSearchPipeline,
  ResourceDiscoveryPage,
} from '@semiont/react-ui';
import type { components } from '@semiont/core';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

const SEARCH_LIMIT = 20;

export default function DiscoverPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Discover.${k}`, p as any) as string;
  const router = useRouter();
  const semiont = useApiClient();

  // Toolbar and settings state
  const browseVM = useBrowseVM();
  const activePanel = useObservable(browseVM.activePanel$) ?? null;
  const { theme, setTheme, resolvedTheme } = useTheme();
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

  // Recent documents and entity types via React Query — these aren't
  // pipeline-building, they're plain reads, so they stay on React Query.
  const resources = useResources();
  const entityTypesAPI = useEntityTypes();
  const { data: recentDocsData, isLoading: isLoadingRecent } = resources.list.useQuery(
    { limit: 10, archived: false }
  );
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();

  // ── Search pipeline ─────────────────────────────────────────────────────
  const [pipeline] = useState(() =>
    createSearchPipeline<ResourceDescriptor>((q) =>
      semiont.browse.resources({ search: q, limit: SEARCH_LIMIT })
    )
  );
  useEffect(() => () => pipeline.dispose(), [pipeline]);

  const searchQuery = useObservable(pipeline.query$) ?? '';
  const searchState = useObservable(pipeline.state$);
  const searchDocuments = searchState?.results ?? [];
  const isSearching = searchState?.isSearching ?? false;

  const recentDocuments = recentDocsData?.resources || [];
  const entityTypes = entityTypesData?.entityTypes || [];

  return (
    <ResourceDiscoveryPage
      recentDocuments={recentDocuments}
      searchDocuments={searchDocuments}
      entityTypes={entityTypes}
      isLoadingRecent={isLoadingRecent}
      isSearching={isSearching}
      searchQuery={searchQuery}
      onSearchQueryChange={pipeline.setQuery}
      theme={resolvedTheme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
      onNavigateToResource={(resourceId) => {
        router.push(`/know/resource/${encodeURIComponent(resourceId)}`);
      }}
      onNavigateToCompose={() => {
        router.push('/know/compose');
      }}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        searchPlaceholder: t('searchPlaceholder'),
        searchButton: t('searchButton'),
        searching: t('searching'),
        filterByEntityType: t('filterByEntityType'),
        all: t('all'),
        recentResources: t('recentResources'),
        searchResults: (count: number) => t('searchResults', { count }),
        documentsTaggedWith: (entityType: string) => t('documentsTaggedWith', { entityType }),
        noResultsFound: (query: string) => t('noResultsFound', { query }),
        noResourcesAvailable: t('noResourcesAvailable'),
        composeFirstResource: t('composeFirstResource'),
        archived: t('archived'),
        created: t('created'),
        loadingKnowledgeBase: t('loadingKnowledgeBase'),
      }}
      ToolbarPanels={ToolbarPanels}
    />
  );
}
