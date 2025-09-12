"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiService } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';
import { AsyncErrorBoundary } from '@/components/ErrorBoundary';

interface AuthenticatedHomeProps {
  userName?: string;
}

export function AuthenticatedHome({ userName }: AuthenticatedHomeProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Document[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newDocName, setNewDocName] = useState('');
  const [newDocContent, setNewDocContent] = useState('');

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const response = await apiService.documents.search(searchQuery, 10);
      setSearchResults(response.documents);
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim()) return;

    setIsCreating(true);
    try {
      const response = await apiService.documents.create({
        name: newDocName,
        content: newDocContent || `# ${newDocName}\n\nStart writing your document here...`,
        contentType: 'text/markdown'
      });
      
      // Navigate to the new document
      router.push(`/documents/${response.document.id}`);
    } catch (error) {
      console.error('Failed to create document:', error);
      alert('Failed to create document. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  const openDocument = (documentId: string) => {
    router.push(`/documents/${documentId}`);
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-8">

      {/* Search Documents Section */}
      <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-6 font-sans">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          Search Documents
        </h2>
        <form onSubmit={handleSearch} className="space-y-4">
          <div className="flex gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by document name..."
              className="flex-1 px-4 py-2 bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50 focus:border-cyan-500/50 dark:focus:border-cyan-400/50 dark:text-white placeholder:text-gray-400 transition-colors"
              disabled={isSearching}
            />
            <button
              type="submit"
              disabled={isSearching || !searchQuery.trim()}
              className="px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105"
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </div>
        </form>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Search Results ({searchResults.length})
            </h3>
            <div className="space-y-2">
              {searchResults.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => openDocument(doc.id)}
                  className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer transition-colors"
                >
                  <h4 className="font-medium text-gray-900 dark:text-white">
                    {doc.name}
                  </h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                    {doc.content.substring(0, 150)}...
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                    Created: {new Date(doc.createdAt).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Create New Document Section */}
      <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-6 font-sans">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Create New Document
        </h2>
        <button
          onClick={() => setShowCreateModal(true)}
          className="w-full py-3 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 hover:from-cyan-600 hover:to-blue-600 dark:from-cyan-600/20 dark:to-blue-600/20 dark:hover:from-cyan-500 dark:hover:to-blue-500 text-cyan-700 hover:text-white dark:text-cyan-400 dark:hover:text-white border border-cyan-400/30 hover:border-cyan-600 dark:border-cyan-500/30 dark:hover:border-cyan-400 rounded-lg transition-all duration-300 transform hover:scale-[1.02] font-medium flex items-center justify-center gap-2 backdrop-blur-sm"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          New Document
        </button>
      </div>

      {/* Create Document Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 font-sans">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-lg">
            <h3 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">
              Create New Document
            </h3>
            <form onSubmit={handleCreateDocument} className="space-y-4">
              <div>
                <label htmlFor="docName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Document Name
                </label>
                <input
                  id="docName"
                  type="text"
                  value={newDocName}
                  onChange={(e) => setNewDocName(e.target.value)}
                  placeholder="Enter document name..."
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  required
                  disabled={isCreating}
                />
              </div>
              <div>
                <label htmlFor="docContent" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Initial Content (Optional)
                </label>
                <textarea
                  id="docContent"
                  value={newDocContent}
                  onChange={(e) => setNewDocContent(e.target.value)}
                  placeholder="Start writing your document content (Markdown supported)..."
                  rows={6}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  disabled={isCreating}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setNewDocName('');
                    setNewDocContent('');
                  }}
                  disabled={isCreating}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating || !newDocName.trim()}
                  className="px-6 py-2 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 hover:from-cyan-600 hover:to-blue-600 dark:from-cyan-600/20 dark:to-blue-600/20 dark:hover:from-cyan-500 dark:hover:to-blue-500 text-cyan-700 hover:text-white dark:text-cyan-400 dark:hover:text-white border border-cyan-400/30 hover:border-cyan-600 dark:border-cyan-500/30 dark:hover:border-cyan-400 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all backdrop-blur-sm"
                >
                  {isCreating ? 'Creating...' : 'Create Document'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Recent Documents Section */}
      <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-6 font-sans">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Recent Documents
        </h2>
        <div className="text-center py-8">
          <svg className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-gray-500 dark:text-gray-400">No recent documents yet</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Create your first document to get started</p>
        </div>
      </div>

    </div>
  );
}