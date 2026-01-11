/**
 * ResourceDiscoveryPage Component
 *
 * Pure React component for resource discovery and search.
 * All dependencies passed as props - no Next.js hooks!
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { components } from '@semiont/api-client';
import { getResourceId } from '@semiont/api-client';
import { useRovingTabIndex, Toolbar, useDebounce } from '@semiont/react-ui';
import { ResourceCard } from './ResourceCard';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface ResourceDiscoveryPageProps {
  // Data props
  recentDocuments: ResourceDescriptor[];
  searchDocuments: ResourceDescriptor[];
  entityTypes: string[];
  isLoadingRecent: boolean;
  isSearching: boolean;

  // UI state props
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  activePanel: string | null;
  onPanelToggle: (panel: string) => void;

  // Navigation props
  onNavigateToResource: (resourceId: string) => void;
  onNavigateToCompose: () => void;

  // Translation props
  translations: {
    title: string;
    subtitle: string;
    searchPlaceholder: string;
    searchButton: string;
    searching: string;
    filterByEntityType: string;
    all: string;
    recentResources: string;
    searchResults: (count: number) => string;
    documentsTaggedWith: (entityType: string) => string;
    noResultsFound: (query: string) => string;
    noResourcesAvailable: string;
    composeFirstResource: string;
    archived: string;
    created: string;
    loadingKnowledgeBase: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
}

export function ResourceDiscoveryPage({
  recentDocuments,
  searchDocuments,
  entityTypes,
  isLoadingRecent,
  isSearching,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  activePanel,
  onPanelToggle,
  onNavigateToResource,
  onNavigateToCompose,
  translations: t,
  ToolbarPanels,
}: ResourceDiscoveryPageProps) {
  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');

  // Debounced search query
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  const hasSearchQuery = searchQuery.trim() !== '';
  const hasSearchResults = searchDocuments.length > 0;

  // Memoized filtered documents
  const filteredResources = useMemo(() => {
    // If we have search results, show them; otherwise show recent
    // This ensures we show recent docs even when search returns nothing
    const baseDocuments = hasSearchResults
      ? searchDocuments
      : recentDocuments;

    if (!selectedEntityType) return baseDocuments;

    return baseDocuments.filter((resource: ResourceDescriptor) =>
      resource.entityTypes && resource.entityTypes.includes(selectedEntityType)
    );
  }, [recentDocuments, searchDocuments, selectedEntityType, hasSearchResults]);

  // Roving tabindex for entity type filters
  const entityFilterRoving = useRovingTabIndex<HTMLDivElement>(
    entityTypes.length + 1, // +1 for "All" button
    { orientation: 'horizontal' }
  );

  // Roving tabindex for document grid
  const documentGridRoving = useRovingTabIndex<HTMLDivElement>(
    filteredResources.length,
    { orientation: 'grid', cols: 2 } // 2 columns on medium+ screens
  );

  // Memoized callbacks
  const handleEntityTypeFilter = useCallback((entityType: string) => {
    setSelectedEntityType(entityType);
  }, []);

  const openResource = useCallback((resource: ResourceDescriptor) => {
    const resourceId = getResourceId(resource);
    if (resourceId) {
      onNavigateToResource(resourceId);
    }
  }, [onNavigateToResource]);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    // Search is handled by debounced effect
  }, []);

  // Loading state
  if (isLoadingRecent) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t.loadingKnowledgeBase}</p>
      </div>
    );
  }

  const showNoResultsWarning = hasSearchQuery && !hasSearchResults && !isSearching;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8 space-y-6">
        {/* Page Header */}
        <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">{t.title}</h1>
        <p className="text-gray-600 dark:text-gray-400">
          {t.subtitle}
        </p>
      </div>

      {/* Search and Filter Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
        {/* Search Bar */}
        <form onSubmit={handleSearchSubmit} className="mb-6">
          <div className="flex gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.searchPlaceholder}
              className="flex-1 px-4 py-2 bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50 focus:border-cyan-500/50 dark:focus:border-cyan-400/50 dark:text-white placeholder:text-gray-400 transition-colors"
              disabled={isSearching}
            />
            <button
              type="submit"
              disabled={isSearching}
              className="px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105"
            >
              {isSearching ? t.searching : t.searchButton}
            </button>
          </div>
        </form>

        {/* Entity Type Filters */}
        {entityTypes.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t.filterByEntityType}
            </h3>
            <div
              ref={entityFilterRoving.containerRef}
              onKeyDown={entityFilterRoving.handleKeyDown}
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Entity type filters"
            >
              <button
                onClick={() => handleEntityTypeFilter('')}
                tabIndex={0}
                aria-pressed={selectedEntityType === ''}
                className={`px-3 py-1 rounded-full text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50 ${
                  selectedEntityType === ''
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {t.all}
              </button>
              {entityTypes.map((type: string) => (
                <button
                  key={type}
                  onClick={() => handleEntityTypeFilter(type)}
                  tabIndex={-1}
                  aria-pressed={selectedEntityType === type}
                  className={`px-3 py-1 rounded-full text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50 ${
                    selectedEntityType === type
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Documents Grid */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            {showNoResultsWarning
              ? t.recentResources
              : hasSearchResults
                ? t.searchResults(searchDocuments.length)
                : selectedEntityType
                  ? t.documentsTaggedWith(selectedEntityType)
                  : t.recentResources
            }
          </h3>

          {showNoResultsWarning && (
            <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                {t.noResultsFound(searchQuery)}
              </p>
            </div>
          )}

          {filteredResources.length > 0 ? (
            <div
              ref={documentGridRoving.containerRef}
              onKeyDown={documentGridRoving.handleKeyDown}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
              role="group"
              aria-label="Document grid"
            >
              {filteredResources.map((resource: ResourceDescriptor, index: number) => (
                <ResourceCard
                  key={getResourceId(resource)}
                  resource={resource}
                  onOpen={openResource}
                  tabIndex={index === 0 ? 0 : -1}
                  archivedLabel={t.archived}
                  createdLabel={t.created}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">
                {t.noResourcesAvailable}
              </p>
              {!hasSearchQuery && (
                <button
                  onClick={onNavigateToCompose}
                  className="mt-4 px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg transition-all duration-300 transform hover:scale-105"
                >
                  {t.composeFirstResource}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="flex">
        {/* Panels Container */}
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={onThemeChange}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={onLineNumbersToggle}
        />

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={onPanelToggle}
        />
      </div>
    </div>
  );
}
