"use client";

import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';
import {
  useTheme,
  useObservable,
  useSemiont,
  useSessionStateUnit,
  ResourceDiscoveryPage,
} from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useShellStateUnit } from '@semiont/react-ui';
import { createDiscoverStateUnit } from '@semiont/react-ui';
export default function DiscoverPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Discover.${k}`, p as any) as string;
  const router = useRouter();
  const session = useObservable(useSemiont().activeSession$) ?? undefined;

  const browseStateUnit = useShellStateUnit();
  const stateUnit = useSessionStateUnit(session, (s) => createDiscoverStateUnit(s, browseStateUnit));

  const activePanel = useObservable(stateUnit?.browse.activePanel$) ?? null;
  const recentDocuments = useObservable(stateUnit?.recent.value$) ?? [];
  const entityTypes = useObservable(stateUnit?.entityTypes.value$) ?? [];
  // Three states: a terminally failed list has no value either, so deriving
  // "loading" from `undefined` left this route spinning for ever.
  // See .plans/PANEL-FAILURE-STATES.md
  const recentError = useObservable(stateUnit?.recent.error$) ?? null;
  const isLoadingRecent = useObservable(stateUnit?.recent.loading$) ?? true;
  const searchQuery = useObservable(stateUnit?.search.query$) ?? '';
  const searchState = useObservable(stateUnit?.search.state$);
  const searchDocuments = searchState?.results ?? [];
  const isSearching = searchState?.isSearching ?? false;
  // Read off the SAME value as the results, never a sibling observable (S10).
  const searchMatchKind = searchState?.matchKind;
  const selectedEntityType = useObservable(stateUnit?.selectedEntityType$) ?? '';

  const { resolvedTheme } = useTheme();

  if (!stateUnit) return null;

  return (
    <ResourceDiscoveryPage
      recentDocuments={recentDocuments}
      searchDocuments={searchDocuments}
      entityTypes={entityTypes}
      isLoadingRecent={isLoadingRecent}
      recentError={recentError}
      onRetryRecent={stateUnit?.recent.retry}
      isSearching={isSearching}
      {...(searchMatchKind ? { searchMatchKind } : {})}
      searchQuery={searchQuery}
      onSearchQueryChange={stateUnit?.search.setQuery}
      selectedEntityType={selectedEntityType}
      onSelectedEntityTypeChange={stateUnit?.setSelectedEntityType}
      theme={resolvedTheme}
      activePanel={activePanel}
      onNavigateToResource={(resourceId) => router.push(`/know/resource/${encodeURIComponent(resourceId)}`)}
      onNavigateToCompose={() => router.push('/know/compose')}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        searchPlaceholder: t('searchPlaceholder'),
        searchButton: t('searchButton'),
        searching: t('searching'),
        semanticFallbackNotice: t('semanticFallbackNotice'),
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
        recentFailed: t('recentFailed'),
        retry: t('retry'),
      }}
      ToolbarPanels={ToolbarPanels}
    />
  );
}
