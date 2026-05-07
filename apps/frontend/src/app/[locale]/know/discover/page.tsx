"use client";

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';
import {
  useTheme,
  useLineNumbers,
  useEventSubscriptions,
  useObservable,
  useSemiont,
  useStateUnit,
  ResourceDiscoveryPage,
} from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useShellStateUnit } from '@semiont/react-ui';
import { createDiscoverStateUnit } from '@semiont/react-ui';
export default function DiscoverPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Discover.${k}`, p as any) as string;
  const router = useRouter();
  const semiont = useObservable(useSemiont().activeSession$)?.client;

  const browseStateUnit = useShellStateUnit();
  const stateUnit = useStateUnit(() => createDiscoverStateUnit(semiont!, browseStateUnit));

  const activePanel = useObservable(stateUnit.browse.activePanel$) ?? null;
  const recentDocuments = useObservable(stateUnit.recentResources$) ?? [];
  const entityTypes = useObservable(stateUnit.entityTypes$) ?? [];
  const isLoadingRecent = useObservable(stateUnit.isLoadingRecent$) ?? true;
  const searchQuery = useObservable(stateUnit.search.query$) ?? '';
  const searchState = useObservable(stateUnit.search.state$);
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
      onSearchQueryChange={stateUnit.search.setQuery}
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
