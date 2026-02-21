/**
 * ResourceDiscoveryPage Component
 *
 * Pure React component for resource discovery and search.
 * All dependencies passed as props - no Next.js hooks!
 */

import React, { useState, useCallback, useRef } from 'react';
import type { components } from '@semiont/core';
import { getResourceId } from '@semiont/api-client';
import { useRovingTabIndex } from '../../../hooks/useRovingTabIndex';
import { Toolbar } from '../../../components/Toolbar';
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
  showLineNumbers: boolean;
  activePanel: string | null;

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
  showLineNumbers,
  activePanel,
  onNavigateToResource,
  onNavigateToCompose,
  translations: t,
  ToolbarPanels,
}: ResourceDiscoveryPageProps) {
  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');

  const hasSearchQuery = searchQuery.trim() !== '';
  const hasSearchResults = searchDocuments.length > 0;

  // Filtered documents
  const baseDocuments = hasSearchResults ? searchDocuments : recentDocuments;
  const filteredResources = !selectedEntityType
    ? baseDocuments
    : baseDocuments.filter((resource: ResourceDescriptor) =>
        resource.entityTypes && resource.entityTypes.includes(selectedEntityType)
      );

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

  // Store navigation callback in ref to avoid re-creating openResource
  const onNavigateToResourceRef = useRef(onNavigateToResource);
  onNavigateToResourceRef.current = onNavigateToResource;

  // Memoized callbacks
  const handleEntityTypeFilter = useCallback((entityType: string) => {
    setSelectedEntityType(entityType);
  }, []);

  const openResource = useCallback((resource: ResourceDescriptor) => {
    const resourceId = getResourceId(resource);
    if (resourceId) {
      onNavigateToResourceRef.current(resourceId);
    }
  }, []);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    // Search is handled by debounced effect
  }, []);

  // Loading state
  if (isLoadingRecent) {
    return (
      <div className="semiont-page__loading">
        <p className="semiont-page__loading-text">{t.loadingKnowledgeBase}</p>
      </div>
    );
  }

  const showNoResultsWarning = hasSearchQuery && !hasSearchResults && !isSearching;

  return (
    <div className={`semiont-page${activePanel ? ' semiont-page--panel-open' : ''}`}>
      {/* Main Content Area */}
      <div className="semiont-page__content">
        {/* Page Header */}
        <div className="semiont-page__header">
          <h1 className="semiont-page__title">{t.title}</h1>
          <p className="semiont-page__subtitle">
            {t.subtitle}
          </p>
        </div>

        {/* Search and Filter Section */}
        <div className="semiont-card">
          {/* Search Bar */}
          <form onSubmit={handleSearchSubmit} className="semiont-card__search-form">
            <div className="semiont-card__search-wrapper">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="semiont-card__search-input"
                disabled={isSearching}
              />
              <button
                type="submit"
                disabled={isSearching}
                className="semiont-card__search-button"
              >
                {isSearching ? t.searching : t.searchButton}
              </button>
            </div>
          </form>

          {/* Entity Type Filters */}
          {entityTypes.length > 0 && (
            <div className="semiont-card__filters">
              <h3 className="semiont-card__filters-label">
                {t.filterByEntityType}
              </h3>
              <div
                ref={entityFilterRoving.containerRef}
                onKeyDown={entityFilterRoving.handleKeyDown}
                className="semiont-card__filter-buttons"
                role="group"
                aria-label="Entity type filters"
              >
                <button
                  onClick={() => handleEntityTypeFilter('')}
                  tabIndex={0}
                  aria-pressed={selectedEntityType === ''}
                  className="semiont-card__filter-button"
                  data-active={selectedEntityType === ''}
                >
                  {t.all}
                </button>
                {entityTypes.map((type: string) => (
                  <button
                    key={type}
                    onClick={() => handleEntityTypeFilter(type)}
                    tabIndex={-1}
                    aria-pressed={selectedEntityType === type}
                    className="semiont-card__filter-button"
                    data-active={selectedEntityType === type}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Documents Grid */}
          <div className="semiont-card__documents">
            <h3 className="semiont-card__documents-label">
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
              <div className="semiont-card__warning">
                <p className="semiont-card__warning-text">
                  {t.noResultsFound(searchQuery)}
                </p>
              </div>
            )}

            {filteredResources.length > 0 ? (
              <div
                ref={documentGridRoving.containerRef}
                onKeyDown={documentGridRoving.handleKeyDown}
                className="semiont-card-grid"
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
              <div className="semiont-card__empty">
                <p className="semiont-card__empty-text">
                  {t.noResourcesAvailable}
                </p>
                {!hasSearchQuery && (
                  <button
                    onClick={onNavigateToCompose}
                    className="semiont-card__empty-button"
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
      <div className="semiont-page__sidebar">
        {/* Panels Container */}
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          showLineNumbers={showLineNumbers}
        />

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activePanel}
        />
      </div>
    </div>
  );
}
