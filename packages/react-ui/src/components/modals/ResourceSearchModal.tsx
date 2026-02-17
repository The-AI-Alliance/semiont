'use client';

import React, { useState, useEffect, Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useResources } from '../../lib/api-hooks';
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
    50 // Limit to 50 results
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
  }, [loading, results.length, debouncedSearch]);

  // Announce when searching
  useEffect(() => {
    if (loading && debouncedSearch) {
      announceSearching();
    }
  }, [loading, debouncedSearch]);

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
      <Dialog as="div" className="semiont-search-modal semiont-search-modal--resource" onClose={onClose}>
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
          <div className="semiont-search-modal__backdrop" />
        </TransitionChild>

        {/* Modal panel */}
        <div className="semiont-search-modal__wrapper">
          <div className="semiont-search-modal__centering semiont-search-modal__centering--center">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="semiont-search-modal__panel semiont-search-modal__panel--with-border">
                <div className="semiont-search-modal__header">
                  <DialogTitle className="semiont-search-modal__title">
                    {t.title}
                  </DialogTitle>
                  <button
                    onClick={onClose}
                    className="semiont-search-modal__close-button"
                    aria-label={t.close}
                  >
                    {t.close}
                  </button>
                </div>

                <form onSubmit={handleSearch} className="semiont-search-modal__search-form">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t.placeholder}
                    className="semiont-search-modal__search-input"
                    autoFocus
                  />
                </form>

                <div className="semiont-search-modal__results">
                  {loading && (
                    <div className="semiont-search-modal__empty">
                      {t.searching}
                    </div>
                  )}

                  {!loading && results.length === 0 && search && (
                    <div className="semiont-search-modal__empty">
                      {t.noResults}
                    </div>
                  )}

                  {!loading && results.length > 0 && (
                    <div className="semiont-search-modal__resource-list">
                      {results.map((resource: any) => {
                        const isImage = resource.mediaType?.startsWith('image/');

                        return (
                          <div
                            key={resource.id}
                            className="semiont-search-modal__resource-item"
                            onClick={() => handleSelect(resource.id, resource.name)}
                          >
                            <h4 className="semiont-search-modal__resource-name">
                              {resource.name}
                            </h4>
                            {resource.content && !isImage && (
                              <p className="semiont-search-modal__resource-description">
                                {resource.content.substring(0, 150)}...
                              </p>
                            )}
                            {isImage && (
                              <p className="semiont-search-modal__resource-media-type">
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