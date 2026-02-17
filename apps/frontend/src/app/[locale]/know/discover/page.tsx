"use client";

/**
 * Resource Discovery Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (routing, data loading, hooks)
 * and delegates rendering to the pure React ResourceDiscoveryPage component.
 */

import React, { useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { useResources, useEntityTypes, useTheme, usePanelNavigation, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { ResourceDiscoveryPage } from '@semiont/react-ui';

/**
 * Main page component - handles Next.js hooks and data loading
 */
export default function DiscoverPage() {
  const t = useTranslations('Discover');
  const router = useRouter();

  // Toolbar and settings state
  const { activePanel } = usePanelNavigation();
  const { theme, setTheme, resolvedTheme } = useTheme();
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

  // API hooks
  const resources = useResources();
  const entityTypesAPI = useEntityTypes();

  // Load recent documents using React Query
  const { data: recentDocsData, isLoading: isLoadingRecent } = resources.list.useQuery(
    { limit: 10, archived: false }
  );

  // Load entity types using React Query
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();

  // Search documents using React Query (only when there's a search query)
  const { data: searchData, isFetching: isSearching } = resources.search.useQuery(
    '',  // Empty search query initially - component will trigger search
    20
  );

  // Extract data from React Query responses
  const recentDocuments = recentDocsData?.resources || [];
  const searchDocuments = searchData?.resources || [];
  const entityTypes = entityTypesData?.entityTypes || [];

  // Render the pure component with all props
  return (
    <ResourceDiscoveryPage
      recentDocuments={recentDocuments}
      searchDocuments={searchDocuments}
      entityTypes={entityTypes}
      isLoadingRecent={isLoadingRecent}
      isSearching={isSearching}
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