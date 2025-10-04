"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import { useRovingTabIndex } from '@/hooks/useRovingTabIndex';
import { useTheme } from '@/hooks/useTheme';
import { Toolbar } from '@/components/Toolbar';
import { SettingsPanel } from '@/components/SettingsPanel';
import { UserPanel } from '@/components/UserPanel';
// Extract document card as a component
const DocumentCard = React.memo(({
  doc,
  onOpen,
  tabIndex = 0
}: {
  doc: Document;
  onOpen: (doc: Document) => void;
  tabIndex?: number;
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
          Archived
        </span>
      )}
    </div>
    
    {doc.content && (
      <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-3">
        {doc.content.replace(/^#+ .*$/gm, '').trim().substring(0, 150)}...
      </p>
    )}
    
    {/* Document Metadata */}
    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-500">
      <span>Updated {new Date(doc.updatedAt).toLocaleDateString()}</span>
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
  const router = useRouter();
  const { addDocument } = useOpenDocuments();

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');

  // Toolbar and settings state
  const [activeToolbarPanel, setActiveToolbarPanel] = useState<'settings' | 'user' | null>(null);
  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });
  const [showLineNumbers, setShowLineNumbers] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('showLineNumbers') === 'true';
    }
    return false;
  });
  const { theme, setTheme } = useTheme();

  // Debounced search query
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Load recent documents using React Query
  const { data: recentDocsData, isLoading: isLoadingRecent } = api.documents.list.useQuery({
    limit: 10,
    archived: false
  });

  // Load entity types using React Query
  const { data: entityTypesData } = api.entityTypes.list.useQuery();

  // Search documents using React Query (only when there's a search query)
  const { data: searchData, isFetching: isSearching } = api.documents.search.useQuery(
    debouncedSearchQuery,
    20,
    { enabled: debouncedSearchQuery.trim() !== '' }
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
  const handleToolbarPanelToggle = useCallback((panel: 'settings') => {
    setActiveToolbarPanel(current => current === panel ? null : panel);
  }, []);

  const handleAnnotateModeToggle = useCallback(() => {
    const newMode = !annotateMode;
    setAnnotateMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('annotateMode', newMode.toString());
    }
  }, [annotateMode]);

  const handleLineNumbersToggle = useCallback(() => {
    const newMode = !showLineNumbers;
    setShowLineNumbers(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('showLineNumbers', newMode.toString());
    }
  }, [showLineNumbers]);

  // Loading state
  if (isLoadingRecent) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">Loading knowledge base...</p>
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
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Discover Knowledge</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Explore your knowledge graph and discover connections
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
              placeholder="Search documents by name or content..."
              className="flex-1 px-4 py-2 bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50 focus:border-cyan-500/50 dark:focus:border-cyan-400/50 dark:text-white placeholder:text-gray-400 transition-colors"
              disabled={isSearching}
            />
            <button
              type="submit"
              disabled={isSearching}
              className="px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105"
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </div>
        </form>

        {/* Entity Type Filters */}
        {entityTypes.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Filter by Entity Type (use arrow keys to navigate)
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
                All
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
              ? 'Recent Documents'
              : hasSearchResults
                ? `Search Results (${searchDocuments.length})`
                : selectedEntityType
                  ? `Documents tagged with "${selectedEntityType}"`
                  : 'Recent Documents'
            }
          </h3>
          
          {showNoResultsWarning && (
            <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                No results found for "{searchQuery}". Showing recent documents instead.
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
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">
                No documents available. Create your first document to get started.
              </p>
              {!hasSearchQuery && (
                <button
                  onClick={() => router.push('/know/compose')}
                  className="mt-4 px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg transition-all duration-300 transform hover:scale-105"
                >
                  Compose First Document
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
        {activeToolbarPanel && (
          <div className="w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 overflow-y-auto p-4">
            {/* User Panel */}
            {activeToolbarPanel === 'user' && (
              <UserPanel />
            )}

            {/* Settings Panel */}
            {activeToolbarPanel === 'settings' && (
              <SettingsPanel
                showLineNumbers={showLineNumbers}
                onLineNumbersToggle={handleLineNumbersToggle}
                theme={theme}
                onThemeChange={setTheme}
              />
            )}
          </div>
        )}

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activeToolbarPanel}
          onPanelToggle={handleToolbarPanelToggle}
        />
      </div>
    </div>
  );
}