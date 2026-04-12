'use client';

import React, { useState, useEffect } from 'react';
import { Dialog, DialogPanel, Transition, TransitionChild } from '@headlessui/react';
import { map } from 'rxjs/operators';
import { getResourceId } from '@semiont/api-client';
import { useSearchAnnouncements } from '../../hooks/useSearchAnnouncements';
import { useApiClient } from '../../contexts/ApiClientContext';
import { useObservable } from '../../hooks/useObservable';
import { createSearchPipeline } from '../../lib/search-pipeline';
import './SearchModal.css';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 5;

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (type: 'resource' | 'entity', id: string) => void;
  translations?: {
    placeholder?: string;
    searching?: string;
    noResults?: string;
    startTyping?: string;
    navigate?: string;
    select?: string;
    close?: string;
    enter?: string;
    esc?: string;
  };
}

interface SearchResult {
  type: 'resource' | 'entity';
  id: string;
  name: string;
  content?: string;
  entityType?: string;
}

export function SearchModal({
  isOpen,
  onClose,
  onNavigate,
  translations = {}
}: SearchModalProps) {
  const { announceSearchResults, announceSearching } = useSearchAnnouncements();
  const semiont = useApiClient();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const t = {
    placeholder: translations.placeholder || 'Search resources, entities...',
    searching: translations.searching || 'Searching...',
    noResults: translations.noResults || 'No results found for',
    startTyping: translations.startTyping || 'Start typing to search...',
    navigate: translations.navigate || 'Navigate',
    select: translations.select || 'Select',
    close: translations.close || 'Close',
    enter: translations.enter || 'Enter',
    esc: translations.esc || 'ESC',
  };

  // ── Search pipeline ─────────────────────────────────────────────────────
  // The fetch closure maps ResourceDescriptor → SearchResult inside the
  // map operator. The helper handles debounce, switchMap, and loading state.
  const [pipeline] = useState(() =>
    createSearchPipeline<SearchResult>(
      (q) =>
        semiont.browse.resources({ search: q, limit: SEARCH_LIMIT }).pipe(
          map((resources) => {
            if (resources === undefined) return undefined;
            return resources
              .map((resource): SearchResult | null => {
                const id = getResourceId(resource);
                if (!id) return null;
                return {
                  type: 'resource',
                  id,
                  name: resource.name,
                  content: (resource as { content?: string }).content?.substring(0, 150),
                };
              })
              .filter((r): r is SearchResult => r !== null);
          }),
        ),
      { debounceMs: SEARCH_DEBOUNCE_MS },
    ),
  );
  useEffect(() => () => pipeline.dispose(), [pipeline]);

  const query = useObservable(pipeline.query$) ?? '';
  const searchState = useObservable(pipeline.state$);
  const results = searchState?.results ?? [];
  const loading = searchState?.isSearching ?? false;

  // Reset query and selection when modal opens.
  useEffect(() => {
    if (isOpen) {
      pipeline.setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen, pipeline]);

  // Reset selection cursor when results change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  // Accessibility announcements for search lifecycle.
  useEffect(() => {
    if (!query.trim()) return;
    if (loading) {
      announceSearching();
    } else {
      announceSearchResults(results.length, query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, results.length]);

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
    onNavigate(result.type, result.id);
  };

  return (
    <Transition appear show={isOpen}>
      <Dialog as="div" className="semiont-search-modal" onClose={onClose}>
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

        {/* Modal */}
        <div className="semiont-search-modal__wrapper">
          <div className="semiont-search-modal__centering">
            <TransitionChild
                           enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="semiont-search-modal__panel">
                {/* Search Input */}
                <div className="semiont-search-modal__input-container">
                  <div className="semiont-search-modal__search-icon-wrapper">
                    <svg className="semiont-search-modal__search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => pipeline.setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t.placeholder}
                    className="semiont-search-modal__input"
                    autoFocus
                  />
                  <div className="semiont-search-modal__esc-wrapper">
                    <kbd className="semiont-search-modal__kbd">
                      {t.esc}
                    </kbd>
                  </div>
                </div>

                {/* Results */}
                <div className="semiont-search-modal__results">
                  {loading && (
                    <div className="semiont-search-modal__empty">
                      {t.searching}
                    </div>
                  )}

                  {!loading && query && results.length === 0 && (
                    <div className="semiont-search-modal__empty">
                      {t.noResults} "{query}"
                    </div>
                  )}

                  {!loading && results.length > 0 && (
                    <div className="semiont-search-modal__results-list">
                      {results.map((result, index) => (
                        <button
                          key={`${result.type}-${result.id}`}
                          onClick={() => navigateToResult(result)}
                          onMouseEnter={() => setSelectedIndex(index)}
                          className={`semiont-search-modal__result ${
                            index === selectedIndex ? 'semiont-search-modal__result--selected' : ''
                          }`}
                        >
                          <div className="semiont-search-modal__result-icon-wrapper">
                            {result.type === 'resource' ? (
                              <svg className="semiont-search-modal__result-icon semiont-search-modal__result-icon--resource" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            ) : (
                              <svg className="semiont-search-modal__result-icon semiont-search-modal__result-icon--entity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                              </svg>
                            )}
                          </div>
                          <div className="semiont-search-modal__result-content">
                            <div className="semiont-search-modal__result-header">
                              <span className="semiont-search-modal__result-name">
                                {result.name}
                              </span>
                              {result.type === 'entity' && result.entityType && (
                                <span className="semiont-search-modal__result-badge">
                                  {result.entityType}
                                </span>
                              )}
                            </div>
                            {result.content && (
                              <p className="semiont-search-modal__result-description">
                                {result.content}
                              </p>
                            )}
                          </div>
                          {index === selectedIndex && (
                            <div className="semiont-search-modal__result-action">
                              <kbd className="semiont-search-modal__kbd">
                                {t.enter}
                              </kbd>
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {!loading && !query && (
                    <div className="semiont-search-modal__help">
                      <div className="semiont-search-modal__help-text">
                        {t.startTyping}
                      </div>
                      <div className="semiont-search-modal__shortcuts">
                        <div className="semiont-search-modal__shortcut">
                          <kbd className="semiont-search-modal__kbd semiont-search-modal__kbd--small">↑↓</kbd>
                          {t.navigate}
                        </div>
                        <div className="semiont-search-modal__shortcut">
                          <kbd className="semiont-search-modal__kbd semiont-search-modal__kbd--small">{t.enter}</kbd>
                          {t.select}
                        </div>
                        <div className="semiont-search-modal__shortcut">
                          <kbd className="semiont-search-modal__kbd semiont-search-modal__kbd--small">Esc</kbd>
                          {t.close}
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