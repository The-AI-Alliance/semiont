'use client';

import React, { useState, useEffect } from 'react';
import { apiService } from '@/lib/api-client';
import { buttonStyles } from '@/lib/button-styles';

interface SearchDocumentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (documentId: string) => void;
  searchTerm?: string;
}

export function SearchDocumentsModal({ isOpen, onClose, onSelect, searchTerm = '' }: SearchDocumentsModalProps) {
  const [search, setSearch] = useState(searchTerm);
  const [results, setResults] = useState<Array<{ id: string; name: string; content: string | null }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && searchTerm) {
      performSearch(searchTerm);
    }
  }, [isOpen, searchTerm]);

  const performSearch = async (query: string) => {
    if (!query) return;

    setLoading(true);
    try {
      const response = await apiService.documents.search(query, 10);
      const documents = response.documents || [];
      setResults(documents.map(doc => ({
        id: doc.id,
        name: doc.name,
        content: doc.content
      })));
    } catch (error) {
      console.error('Failed to search documents:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    performSearch(search);
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[1001]"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-6 w-[600px] max-h-[80vh] overflow-y-auto z-[1002]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Search Documents
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSearch} className="mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search for documents..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 text-gray-900 dark:text-white"
            autoFocus
          />
        </form>

        {loading && (
          <div className="text-center py-4 text-gray-600 dark:text-gray-400">
            Searching...
          </div>
        )}

        {!loading && results.length === 0 && search && (
          <div className="text-center py-4 text-gray-600 dark:text-gray-400">
            No documents found
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="space-y-2">
            {results.map((doc) => (
              <div
                key={doc.id}
                className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
                onClick={() => {
                  onSelect(doc.id);
                  onClose();
                }}
              >
                <h4 className="font-medium text-gray-900 dark:text-white mb-1">
                  {doc.name}
                </h4>
                {doc.content && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                    {doc.content.substring(0, 150)}...
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}