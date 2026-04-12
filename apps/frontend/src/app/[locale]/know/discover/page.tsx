"use client";

/**
 * Resource Discovery Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (routing, data loading, hooks)
 * and delegates rendering to the pure React ResourceDiscoveryPage component.
 *
 * Search is wired through an RxJS pipeline: a Subject collects raw input from
 * the controlled component, debouncing + switchMap calls into the api-client's
 * Observable browse.resources({ search }) interface, and useObservable surfaces
 * the latest result for rendering.
 */

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import type { components } from '@semiont/core';
import { Subject, of, EMPTY, type Observable } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, startWith, map } from 'rxjs/operators';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type SearchState = { results: ResourceDescriptor[]; isSearching: boolean };
const EMPTY_SEARCH: SearchState = { results: [], isSearching: false };
const SEARCHING: SearchState = { results: [], isSearching: true };
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';
import { useResources, useEntityTypes, useTheme, usePanelBrowse, useLineNumbers, useEventSubscriptions, useObservable, useApiClient } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { ResourceDiscoveryPage } from '@semiont/react-ui';

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 20;

/**
 * Main page component - handles Next.js hooks and data loading
 */
export default function DiscoverPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Discover.${k}`, p as any) as string;
  const router = useRouter();
  const semiont = useApiClient();

  // Toolbar and settings state
  const { activePanel } = usePanelBrowse();
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

  // ── Search pipeline ─────────────────────────────────────────────────────
  // The Subject receives raw input as the user types; the pipeline debounces,
  // switches to the latest browse.resources Observable, and emits result tuples
  // of [results, isSearching]. The component reads searchQuery as plain state
  // for the controlled input.
  const [searchQuery, setSearchQuery] = useState('');
  const searchInput$ = useMemo(() => new Subject<string>(), []);

  const searchState$: Observable<SearchState> = useMemo(() => {
    if (!semiont) return EMPTY;
    return searchInput$.pipe(
      startWith(''),
      debounceTime(SEARCH_DEBOUNCE_MS),
      distinctUntilChanged(),
      switchMap((query): Observable<SearchState> => {
        const trimmed = query.trim();
        if (!trimmed) {
          return of(EMPTY_SEARCH);
        }
        return semiont.browse.resources({ search: trimmed, limit: SEARCH_LIMIT }).pipe(
          map((results): SearchState => ({
            results: results ?? [],
            isSearching: results === undefined,
          })),
          startWith(SEARCHING),
        );
      }),
    );
  }, [semiont, searchInput$]);

  const searchState = useObservable<SearchState>(searchState$);
  const searchDocuments = searchState?.results ?? [];
  const isSearching = searchState?.isSearching ?? false;

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    searchInput$.next(query);
  }, [searchInput$]);

  useEffect(() => () => searchInput$.complete(), [searchInput$]);

  // Extract data from React Query responses
  const recentDocuments = recentDocsData?.resources || [];
  const entityTypes = entityTypesData?.entityTypes || [];

  // Render the pure component with all props
  return (
    <ResourceDiscoveryPage
      recentDocuments={recentDocuments}
      searchDocuments={searchDocuments}
      entityTypes={entityTypes}
      isLoadingRecent={isLoadingRecent}
      isSearching={isSearching}
      searchQuery={searchQuery}
      onSearchQueryChange={handleSearchQueryChange}
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