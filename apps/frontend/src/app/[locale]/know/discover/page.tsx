"use client";

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';
import {
  useTheme,
  useLineNumbers,
  useEventSubscriptions,
  useObservable,
  useApiClient,
  useViewModel,
  ResourceDiscoveryPage,
} from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useBrowseVM } from '@semiont/react-ui';
import { createDiscoverPageVM } from '@semiont/api-client';

export default function DiscoverPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Discover.${k}`, p as any) as string;
  const router = useRouter();
  const semiont = useApiClient();

  const browseVM = useBrowseVM();
  const vm = useViewModel(() => createDiscoverPageVM(semiont, browseVM));

  const activePanel = useObservable(vm.browse.activePanel$) ?? null;
  const recentDocuments = useObservable(vm.recentResources$) ?? [];
  const entityTypes = useObservable(vm.entityTypes$) ?? [];
  const isLoadingRecent = useObservable(vm.isLoadingRecent$) ?? true;
  const searchQuery = useObservable(vm.search.query$) ?? '';
  const searchState = useObservable(vm.search.state$);
  const searchDocuments = searchState?.results ?? [];
  const isSearching = searchState?.isSearching ?? false;

  const { theme, setTheme, resolvedTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  useEventSubscriptions({
    'settings:theme-changed': useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => setTheme(theme), [setTheme]),
    'settings:line-numbers-toggled': useCallback(() => toggleLineNumbers(), [toggleLineNumbers]),
  });

  return (
    <ResourceDiscoveryPage
      recentDocuments={recentDocuments}
      searchDocuments={searchDocuments}
      entityTypes={entityTypes}
      isLoadingRecent={isLoadingRecent}
      isSearching={isSearching}
      searchQuery={searchQuery}
      onSearchQueryChange={vm.search.setQuery}
      theme={resolvedTheme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
      onNavigateToResource={(resourceId) => router.push(`/know/resource/${encodeURIComponent(resourceId)}`)}
      onNavigateToCompose={() => router.push('/know/compose')}
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
