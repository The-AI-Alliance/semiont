'use client';

import React, { useState, useEffect, Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useResources } from '../../hooks/useResources';
import { useSearchAnnouncements } from '../../hooks/useSearchAnnouncements';

interface ResourceSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (resourceId: string) => void;
  searchTerm?: string;
  translations?: {
    title?: string;
    placeholder?: string;
    searching?: string;
    noResults?: string;
    close?: string;
  };
}

export function ResourceSearchModal({
  isOpen,
  onClose,
  onSelect,
  searchTerm = '',
  translations = {}
}: ResourceSearchModalProps) {
  const { announceSearchResults, announceSearching, announceNavigation } = useSearchAnnouncements();
  const [search, setSearch] = useState(searchTerm);
  const [debouncedSearch, setDebouncedSearch] = useState(searchTerm);

  const t = {
    title: translations.title || 'Search Resources',
    placeholder: translations.placeholder || 'Search for resources...',
    searching: translations.searching || 'Searching...',
    noResults: translations.noResults || 'No documents found',
    close: translations.close || '✕',
  };

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Use React Query for search
  const resources = useResources();
  const { data: searchData, isFetching: loading } = resources.search.useQuery(
    debouncedSearch,
    10
  );

  // Extract results from search data
  const results = searchData?.resources?.map((resource: any) => {
    // Get mediaType from primary representation
    const reps = resource.representations;
    const mediaType = Array.isArray(reps) && reps.length > 0 && reps[0]
      ? reps[0].mediaType
      : undefined;

    return {
      id: resource['@id'],
      name: resource.name,
      content: resource.content,
      mediaType
    };
  }) || [];

  // Announce search results
  useEffect(() => {
    if (!loading && debouncedSearch) {
      announceSearchResults(results.length, debouncedSearch);
    }
  }, [loading, results.length, debouncedSearch, announceSearchResults]);

  // Announce when searching
  useEffect(() => {
    if (loading && debouncedSearch) {
      announceSearching();
    }
  }, [loading, debouncedSearch, announceSearching]);

  // Update search term when modal opens
  useEffect(() => {
    if (isOpen && searchTerm) {
      setSearch(searchTerm);
      setDebouncedSearch(searchTerm);
    }
  }, [isOpen, searchTerm]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // Search is handled by React Query hook
  };

  const handleSelect = (resourceId: string, resourceName: string) => {
    announceNavigation(resourceName, 'resource');
    onSelect(resourceId);
    onClose();
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[1001]" onClose={onClose}>
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

        {/* Modal panel */}
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-[600px] transform overflow-hidden rounded-lg bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 p-6 transition-all">
                <div className="flex items-center justify-between mb-4">
                  <DialogTitle className="text-lg font-semibold text-gray-900 dark:text-white">
                    {t.title}
                  </DialogTitle>
                  <button
                    onClick={onClose}
                    className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300"
                    aria-label={t.close}
                  >
                    {t.close}
                  </button>
                </div>

                <form onSubmit={handleSearch} className="mb-4">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t.placeholder}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 text-gray-900 dark:text-white"
                    autoFocus
                  />
                </form>

                <div className="max-h-[60vh] overflow-y-auto">
                  {loading && (
                    <div className="text-center py-4 text-gray-600 dark:text-gray-400">
                      {t.searching}
                    </div>
                  )}

                  {!loading && results.length === 0 && search && (
                    <div className="text-center py-4 text-gray-600 dark:text-gray-400">
                      {t.noResults}
                    </div>
                  )}

                  {!loading && results.length > 0 && (
                    <div className="space-y-2">
                      {results.map((resource: any) => {
                        const isImage = resource.mediaType?.startsWith('image/');

                        return (
                          <div
                            key={resource.id}
                            className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
                            onClick={() => handleSelect(resource.id, resource.name)}
                          >
                            <h4 className="font-medium text-gray-900 dark:text-white mb-1">
                              {resource.name}
                            </h4>
                            {resource.content && !isImage && (
                              <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                                {resource.content.substring(0, 150)}...
                              </p>
                            )}
                            {isImage && (
                              <p className="text-sm text-gray-500 dark:text-gray-500 italic">
                                {resource.mediaType}
                              </p>
                            )}
                          </div>
                        );
                      })}
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