'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { map } from 'rxjs/operators';
import { getResourceId, getPrimaryRepresentation, createSearchPipeline } from '@semiont/api-client';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';
import { useSearchAnnouncements } from '../../hooks/useSearchAnnouncements';

import type { ResourceDescriptor } from '@semiont/core';

type SearchResult = {
  id: string;
  name: string;
  content?: string;
  mediaType?: string;
};

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 50;

function toSearchResult(resource: ResourceDescriptor & { content?: string }): SearchResult | null {
  const id = getResourceId(resource);
  if (!id) return null;
  const primary = getPrimaryRepresentation(resource);
  return {
    id,
    name: resource.name,
    content: resource.content,
    mediaType: primary?.mediaType,
  };
}

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
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  // Pipeline factory captures `semiont` once via useState; if semiont is
  // still loading at first render the captured value would be undefined.
  // Route through a ref so the fetch closure reads the latest client.
  const semiontRef = useRef(semiont);
  semiontRef.current = semiont;

  const t = {
    title: translations.title || 'Search Resources',
    placeholder: translations.placeholder || 'Search for resources...',
    searching: translations.searching || 'Searching...',
    noResults: translations.noResults || 'No documents found',
    close: translations.close || '✕',
  };

  // ── Search pipeline ─────────────────────────────────────────────────────
  const [pipeline] = useState(() =>
    createSearchPipeline<SearchResult>(
      (q) =>
        semiontRef.current!.browse.resources({ search: q, limit: SEARCH_LIMIT }).pipe(
          map((resources) => {
            if (resources === undefined) return undefined;
            return resources
              .map(toSearchResult)
              .filter((r): r is SearchResult => r !== null);
          }),
        ),
      { debounceMs: SEARCH_DEBOUNCE_MS, initialQuery: searchTerm },
    ),
  );
  useEffect(() => () => pipeline.dispose(), [pipeline]);

  const search = useObservable(pipeline.query$) ?? '';
  const searchState = useObservable(pipeline.state$);
  const results = searchState?.results ?? [];
  const loading = searchState?.isSearching ?? false;

  // Re-seed when modal re-opens with a different searchTerm prop. The
  // initialQuery option only applies to the first construction; subsequent
  // prop changes need an explicit setQuery.
  useEffect(() => {
    if (isOpen && searchTerm) {
      pipeline.setQuery(searchTerm);
    }
  }, [isOpen, searchTerm, pipeline]);

  // Accessibility announcements for search lifecycle.
  useEffect(() => {
    if (!search.trim()) return;
    if (loading) {
      announceSearching();
    } else {
      announceSearchResults(results.length, search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, results.length]);

  const handleSelect = (resourceId: string, resourceName: string) => {
    announceNavigation(resourceName, 'resource');
    onSelect(resourceId);
    onClose();
  };

  return (
    <Transition appear show={isOpen}>
      <Dialog as="div" className="semiont-search-modal semiont-search-modal--resource" onClose={onClose}>
        {/* Backdrop */}
        <TransitionChild
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

                <div className="semiont-search-modal__search-form">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => pipeline.setQuery(e.target.value)}
                    placeholder={t.placeholder}
                    className="semiont-search-modal__search-input"
                    autoFocus
                  />
                </div>

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
                      {results.map((resource) => {
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