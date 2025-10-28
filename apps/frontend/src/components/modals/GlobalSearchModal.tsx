'use client';

import React, { useState, useEffect, Fragment } from 'react';
import { Dialog, DialogPanel, Transition, TransitionChild } from '@headlessui/react';
import { useRouter } from '@/i18n/routing';
import { documents } from '@/lib/api/documents';
import { useSearchAnnouncements } from '@/components/LiveRegion';
import { getDocumentId } from '@/lib/resource-helpers';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SearchResult {
  type: 'document' | 'entity';
  id: string;
  name: string;
  content?: string;
  entityType?: string;
}

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const router = useRouter();
  const { announceSearchResults, announceSearching } = useSearchAnnouncements();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Debounce query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Use React Query for search
  const { data: searchData, isFetching: loading } = documents.search.useQuery(
    debouncedQuery,
    5
  );

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setDebouncedQuery('');
      setResults([]);
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Update results when search data changes
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setResults([]);
      return;
    }

    if (loading) {
      announceSearching();
    } else if (searchData) {
      const docResults: SearchResult[] = (searchData.documents || []).map((doc: any) => ({
        type: 'document' as const,
        id: getDocumentId(doc),
        name: doc.name,
        content: doc.content?.substring(0, 150)
      }));

      // Search entities - Currently entities API may not be available
      // TODO: Add entities search when API is ready
      const entityResults: SearchResult[] = [];

      const allResults = [...docResults, ...entityResults];
      setResults(allResults);
      setSelectedIndex(0);
      announceSearchResults(allResults.length, debouncedQuery);
    }
  }, [searchData, loading, debouncedQuery, announceSearchResults, announceSearching]);

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + Math.max(1, results.length)) % Math.max(1, results.length));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      navigateToResult(results[selectedIndex]);
    }
  };

  const navigateToResult = (result: SearchResult) => {
    onClose();
    if (result.type === 'document') {
      router.push(`/know/document/${encodeURIComponent(result.id)}`);
    } else {
      router.push(`/know/entity/${result.id}`);
    }
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[1000]" onClose={onClose}>
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" />
        </TransitionChild>

        {/* Modal */}
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-start justify-center p-4 pt-[10vh]">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-2xl transform overflow-hidden rounded-lg bg-white dark:bg-gray-800 shadow-xl transition-all">
                {/* Search Input */}
                <div className="flex items-center border-b border-gray-200 dark:border-gray-700">
                  <div className="flex-shrink-0 px-4 py-3">
                    <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search documents, entities..."
                    className="flex-1 px-4 py-3 bg-transparent text-gray-900 dark:text-white focus:outline-none"
                    autoFocus
                  />
                  <div className="flex-shrink-0 px-4 py-3">
                    <kbd className="px-2 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
                      ESC
                    </kbd>
                  </div>
                </div>

                {/* Results */}
                <div className="max-h-[60vh] overflow-y-auto">
                  {loading && (
                    <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                      Searching...
                    </div>
                  )}

                  {!loading && query && results.length === 0 && (
                    <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                      No results found for "{query}"
                    </div>
                  )}

                  {!loading && results.length > 0 && (
                    <div className="py-2">
                      {results.map((result, index) => (
                        <button
                          key={`${result.type}-${result.id}`}
                          onClick={() => navigateToResult(result)}
                          onMouseEnter={() => setSelectedIndex(index)}
                          className={`w-full px-4 py-3 flex items-start gap-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                            index === selectedIndex ? 'bg-gray-50 dark:bg-gray-700/50' : ''
                          }`}
                        >
                          <div className="flex-shrink-0 mt-0.5">
                            {result.type === 'document' ? (
                              <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            ) : (
                              <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1 text-left">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-gray-900 dark:text-white">
                                {result.name}
                              </span>
                              {result.type === 'entity' && result.entityType && (
                                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                                  {result.entityType}
                                </span>
                              )}
                            </div>
                            {result.content && (
                              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                                {result.content}
                              </p>
                            )}
                          </div>
                          {index === selectedIndex && (
                            <div className="flex-shrink-0 flex items-center">
                              <kbd className="px-2 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
                                Enter
                              </kbd>
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {!loading && !query && (
                    <div className="px-4 py-8">
                      <div className="text-center text-gray-500 dark:text-gray-400 mb-4">
                        Start typing to search...
                      </div>
                      <div className="flex flex-wrap justify-center gap-2">
                        <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                          <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded">↑↓</kbd>
                          Navigate
                        </div>
                        <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                          <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded">Enter</kbd>
                          Select
                        </div>
                        <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                          <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded">Esc</kbd>
                          Close
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}