"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { documents } from '@/lib/api/documents';
import { entityTypes as entityTypesAPI } from '@/lib/api/entity-types';
import type { components } from '@semiont/api-client';

type Document = components['schemas']['Document'];
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import { useRovingTabIndex } from '@/hooks/useRovingTabIndex';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';
import { Toolbar } from '@/components/Toolbar';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
// Extract document card as a component
const DocumentCard = React.memo(({
  doc,
  onOpen,
  tabIndex = 0,
  archivedLabel,
  createdLabel
}: {
  doc: Document;
  onOpen: (doc: Document) => void;
  tabIndex?: number;
  archivedLabel: string;
  createdLabel: string;
}) => (
  <div
    onClick={() => onOpen(doc)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(doc);
      }
    }}
    role="button"
    tabIndex={tabIndex}
    aria-label={`Open document: ${doc.name}`}
    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-all hover:shadow-md group focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50"
  >
    <div className="flex justify-between items-start mb-2">
      <h4 className="font-medium text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
        {doc.name}
      </h4>
      {doc.archived && (
        <span className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">
          {archivedLabel}
        </span>
      )}
    </div>

    {/* Document Metadata */}
    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-500">
      <span>{createdLabel} {new Date(doc.created).toLocaleDateString()}</span>
      {doc.entityTypes && doc.entityTypes.length > 0 && (
        <div className="flex gap-1">
          {doc.entityTypes.slice(0, 2).map((type) => (
            <span
              key={type}
              className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded"
            >
              {type}
            </span>
          ))}
          {doc.entityTypes.length > 2 && (
            <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">
              +{doc.entityTypes.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  </div>
));

DocumentCard.displayName = 'DocumentCard';

// Custom hook for debounced search
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

export default function DiscoverPage() {
  const t = useTranslations('Discover');
  const router = useRouter();
  const { addDocument } = useOpenDocuments();

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // Debounced search query
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Load recent documents using React Query
  const { data: recentDocsData, isLoading: isLoadingRecent } = documents.list.useQuery(
    10,
    false
  );

  // Load entity types using React Query
  const { data: entityTypesData } = entityTypesAPI.all.useQuery();

  // Search documents using React Query (only when there's a search query)
  const { data: searchData, isFetching: isSearching } = documents.search.useQuery(
    debouncedSearchQuery,
    20
  );

  // Extract data from React Query responses
  const recentDocuments = recentDocsData?.documents || [];
  const searchDocuments = searchData?.documents || [];
  const entityTypes = entityTypesData?.entityTypes || [];

  const hasSearchQuery = searchQuery.trim() !== '';
  const hasSearchResults = searchDocuments.length > 0;

  // Memoized filtered documents
  const filteredDocuments = useMemo(() => {
    // If we have search results, show them; otherwise show recent
    // This ensures we show recent docs even when search returns nothing
    const baseDocuments = hasSearchResults
      ? searchDocuments
      : recentDocuments;

    if (!selectedEntityType) return baseDocuments;

    return baseDocuments.filter((doc: Document) =>
      doc.entityTypes && doc.entityTypes.includes(selectedEntityType)
    );
  }, [recentDocuments, searchDocuments, selectedEntityType, hasSearchResults]);

  // Roving tabindex for entity type filters
  const entityFilterRoving = useRovingTabIndex<HTMLDivElement>(
    entityTypes.length + 1, // +1 for "All" button
    { orientation: 'horizontal' }
  );

  // Roving tabindex for document grid
  const documentGridRoving = useRovingTabIndex<HTMLDivElement>(
    filteredDocuments.length,
    { orientation: 'grid', cols: 2 } // 2 columns on medium+ screens
  );

  // Memoized callbacks
  const handleEntityTypeFilter = useCallback((entityType: string) => {
    setSelectedEntityType(entityType);
  }, []);

  const openDocument = useCallback((doc: Document) => {
    router.push(`/know/document/${encodeURIComponent(doc.id)}`);
  }, [router]);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    // Search is handled by debounced effect
  }, []);

  // Toolbar handlers
  // Loading state
  if (isLoadingRecent) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t('loadingKnowledgeBase')}</p>
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
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">{t('title')}</h1>
        <p className="text-gray-600 dark:text-gray-400">
          {t('subtitle')}
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
              placeholder={t('searchPlaceholder')}
              className="flex-1 px-4 py-2 bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50 focus:border-cyan-500/50 dark:focus:border-cyan-400/50 dark:text-white placeholder:text-gray-400 transition-colors"
              disabled={isSearching}
            />
            <button
              type="submit"
              disabled={isSearching}
              className="px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105"
            >
              {isSearching ? t('searching') : t('searchButton')}
            </button>
          </div>
        </form>

        {/* Entity Type Filters */}
        {entityTypes.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t('filterByEntityType')}
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
                {t('all')}
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
              ? t('recentDocuments')
              : hasSearchResults
                ? t('searchResults', { count: searchDocuments.length })
                : selectedEntityType
                  ? t('documentsTaggedWith', { entityType: selectedEntityType })
                  : t('recentDocuments')
            }
          </h3>

          {showNoResultsWarning && (
            <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                {t('noResultsFound', { query: searchQuery })}
              </p>
            </div>
          )}
          
          {filteredDocuments.length > 0 ? (
            <div
              ref={documentGridRoving.containerRef}
              onKeyDown={documentGridRoving.handleKeyDown}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
              role="group"
              aria-label="Document grid"
            >
              {filteredDocuments.map((doc: Document, index: number) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  onOpen={openDocument}
                  tabIndex={index === 0 ? 0 : -1}
                  archivedLabel={t('archived')}
                  createdLabel={t('created')}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">
                {t('noDocumentsAvailable')}
              </p>
              {!hasSearchQuery && (
                <button
                  onClick={() => router.push('/know/compose')}
                  className="mt-4 px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg transition-all duration-300 transform hover:scale-105"
                >
                  {t('composeFirstDocument')}
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
          onThemeChange={setTheme}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={toggleLineNumbers}
        />

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={togglePanel}
        />
      </div>
    </div>
  );
}