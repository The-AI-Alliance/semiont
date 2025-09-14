"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { apiService } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';

export default function DiscoverPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { addDocument } = useOpenDocuments();
  
  // State for documents
  const [recentDocuments, setRecentDocuments] = useState<Document[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Document[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  // State for filters and stats
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [stats, setStats] = useState<{
    documentCount: number;
    selectionCount: number;
    highlightCount: number;
    referenceCount: number;
  } | null>(null);

  // Load initial data
  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.backendToken) {
      router.push('/auth/signin');
      return;
    }

    const loadInitialData = async () => {
      try {
        // Set auth token
        const { LazyTypedAPIClient } = require('@/lib/api-client');
        LazyTypedAPIClient.getInstance().setAuthToken(session.backendToken);
        
        // Load recent documents
        const docsResponse = await apiService.documents.list({ limit: 10 });
        setRecentDocuments(docsResponse.documents);
        
        // Load entity types - get from schema description
        const schemaResponse = await apiService.documents.schemaDescription();
        if (schemaResponse.statistics?.entityTypes) {
          setEntityTypes(Object.keys(schemaResponse.statistics.entityTypes));
        }
        
        // Load stats from schema description
        if (schemaResponse.statistics) {
          setStats({
            documentCount: schemaResponse.statistics.documentCount || 0,
            selectionCount: schemaResponse.statistics.selectionCount || 0,
            highlightCount: schemaResponse.statistics.highlightCount || 0,
            referenceCount: schemaResponse.statistics.referenceCount || 0
          });
        }
      } catch (error) {
        console.error('Failed to load initial data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadInitialData();
  }, [session, status, router]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const response = await apiService.documents.search(searchQuery, 20);
      setSearchResults(response.documents);
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleEntityTypeFilter = async (entityType: string) => {
    setSelectedEntityType(entityType);
    setIsLoading(true);
    
    try {
      // Note: Current API doesn't support filtering by entity type directly
      // We'll filter client-side for now
      const response = await apiService.documents.list({ limit: 50 });
      
      if (entityType) {
        // Filter documents client-side by entity type
        const filtered = response.documents.filter(doc => 
          doc.entityTypes && doc.entityTypes.includes(entityType)
        );
        setRecentDocuments(filtered.slice(0, 20));
      } else {
        // Show first 10 documents
        setRecentDocuments(response.documents.slice(0, 10));
      }
    } catch (error) {
      console.error('Failed to filter documents:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const openDocument = (doc: Document) => {
    addDocument(doc.id, doc.name);
    router.push(`/know/document/${doc.id}`);
  };

  const documentsToShow = searchResults.length > 0 ? searchResults : recentDocuments;

  if (status === 'loading' || isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">Loading knowledge base...</p>
      </div>
    );
  }

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
        <form onSubmit={handleSearch} className="mb-6">
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
            {searchQuery && searchResults.length === 0
              ? 'Recent Documents'
              : searchResults.length > 0 
                ? `Search Results (${searchResults.length})`
                : selectedEntityType 
                  ? `Documents tagged with "${selectedEntityType}"`
                  : 'Recent Documents'
            }
          </h3>
          {searchQuery && searchResults.length === 0 && (
            <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                No results found for "{searchQuery}". Showing recent documents instead.
              </p>
            </div>
          )}
          
          {documentsToShow.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {documentsToShow.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => openDocument(doc)}
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
                  
                  <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-3">
                    {doc.content.replace(/^#+ .*$/gm, '').trim().substring(0, 150)}...
                  </p>
                  
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
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">
                No documents available. Create your first document to get started.
              </p>
              {!searchQuery && (
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