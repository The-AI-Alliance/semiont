"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireAuth } from '@/hooks/useSecureAPI';
import { apiService } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';

// Extract document card as a component
const DocumentCard = React.memo(({ 
  doc, 
  onOpen 
}: { 
  doc: Document; 
  onOpen: (doc: Document) => void;
}) => (
  <div
    onClick={() => onOpen(doc)}
    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-all hover:shadow-md group"
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
              className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded"
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
  const { isAuthenticated, isLoading: authLoading } = useRequireAuth();
  const { addDocument } = useOpenDocuments();
  
  // Consolidated state for documents
  const [documents, setDocuments] = useState({
    recent: [] as Document[],
    search: [] as Document[],
    isSearching: false,
    isLoading: true,
  });
  
  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  
  // Debounced search query
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Load initial data when authentication is ready
  useEffect(() => {
    // Wait for auth to be ready - token is already set by SecureAPIProvider
    if (!isAuthenticated) return;

    const loadInitialData = async () => {
      try {
        // Load recent documents - auth token is already set globally
        const docsResponse = await apiService.documents.list({ limit: 10 });
        
        setDocuments(prev => ({
          ...prev,
          recent: docsResponse.documents,
          isLoading: false,
        }));
        
        // Load entity types using the same method as entity-tags page
        try {
          const entityTypesResponse = await apiService.entityTypes.list();
          setEntityTypes(entityTypesResponse.entityTypes || []);
        } catch (error) {
          console.warn('Could not load entity types:', error);
          // Extract entity types from loaded documents as fallback
          const typesFromDocs = new Set<string>();
          docsResponse.documents.forEach((doc: Document) => {
            doc.entityTypes?.forEach(type => typesFromDocs.add(type));
          });
          setEntityTypes(Array.from(typesFromDocs));
        }
      } catch (error) {
        console.error('Failed to load initial data:', error);
        setDocuments(prev => ({ ...prev, isLoading: false }));
      }
    };

    loadInitialData();
  }, [isAuthenticated]);

  // Perform search when debounced query changes
  useEffect(() => {
    if (!debouncedSearchQuery.trim()) {
      setDocuments(prev => ({ ...prev, search: [] }));
      return;
    }

    const performSearch = async () => {
      setDocuments(prev => ({ ...prev, isSearching: true }));
      try {
        const response = await apiService.documents.search(debouncedSearchQuery, 20);
        setDocuments(prev => ({
          ...prev,
          search: response.documents,
          isSearching: false,
        }));
      } catch (error) {
        console.error('Search failed:', error);
        setDocuments(prev => ({
          ...prev,
          search: [],
          isSearching: false,
        }));
      }
    };

    performSearch();
  }, [debouncedSearchQuery]);

  const hasSearchQuery = searchQuery.trim() !== '';
  const hasSearchResults = documents.search.length > 0;

  // Memoized filtered documents
  const filteredDocuments = useMemo(() => {
    // If we have search results, show them; otherwise show recent
    // This ensures we show recent docs even when search returns nothing
    const baseDocuments = hasSearchResults
      ? documents.search 
      : documents.recent;
    
    if (!selectedEntityType) return baseDocuments;
    
    return baseDocuments.filter(doc => 
      doc.entityTypes && doc.entityTypes.includes(selectedEntityType)
    );
  }, [documents.recent, documents.search, selectedEntityType, hasSearchResults]);

  // Memoized callbacks
  const handleEntityTypeFilter = useCallback((entityType: string) => {
    setSelectedEntityType(entityType);
  }, []);

  const openDocument = useCallback((doc: Document) => {
    addDocument(doc.id, doc.name);
    router.push(`/know/document/${doc.id}`);
  }, [addDocument, router]);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    // Search is handled by debounced effect
  }, []);

  // Loading state
  if (authLoading || documents.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">Loading knowledge base...</p>
      </div>
    );
  }

  const showNoResultsWarning = hasSearchQuery && !hasSearchResults && !documents.isSearching;

  return (
    <div className="px-4 py-8 space-y-6">
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
              disabled={documents.isSearching}
            />
            <button
              type="submit"
              disabled={documents.isSearching}
              className="px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105"
            >
              {documents.isSearching ? 'Searching...' : 'Search'}
            </button>
          </div>
        </form>

        {/* Entity Type Filters */}
        {entityTypes.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Filter by Entity Type
            </h3>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleEntityTypeFilter('')}
                className={`px-3 py-1 rounded-full text-sm transition-colors ${
                  selectedEntityType === ''
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                All
              </button>
              {entityTypes.map((type) => (
                <button
                  key={type}
                  onClick={() => handleEntityTypeFilter(type)}
                  className={`px-3 py-1 rounded-full text-sm transition-colors ${
                    selectedEntityType === type
                      ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-700'
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
                ? `Search Results (${documents.search.length})`
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredDocuments.map((doc) => (
                <DocumentCard key={doc.id} doc={doc} onOpen={openDocument} />
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
  );
}