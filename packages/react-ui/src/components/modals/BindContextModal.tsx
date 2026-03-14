'use client';

import React, { useState, useEffect, Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import type { GatheredContext } from '@semiont/core';

interface BindContextModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (searchTerm: string, context: GatheredContext) => void;
  searchTerm: string;
  context: GatheredContext | null;
  contextLoading: boolean;
  contextError: Error | null;
  translations?: {
    title?: string;
    searchTermLabel?: string;
    searchTermPlaceholder?: string;
    sourceContextLabel?: string;
    entityTypesLabel?: string;
    graphContextLabel?: string;
    connectionsLabel?: string;
    citedByLabel?: string;
    siblingTypesLabel?: string;
    loadingContext?: string;
    failedContext?: string;
    search?: string;
    cancel?: string;
  };
}

export function BindContextModal({
  isOpen,
  onClose,
  onSearch,
  searchTerm: initialSearchTerm,
  context,
  contextLoading,
  contextError,
  translations = {},
}: BindContextModalProps) {
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm);

  const t = {
    title: translations.title || 'Find Resource',
    searchTermLabel: translations.searchTermLabel || 'Search term',
    searchTermPlaceholder: translations.searchTermPlaceholder || 'Enter search term...',
    sourceContextLabel: translations.sourceContextLabel || 'Source context',
    entityTypesLabel: translations.entityTypesLabel || 'Entity types',
    graphContextLabel: translations.graphContextLabel || 'Graph context',
    connectionsLabel: translations.connectionsLabel || 'Connected resources',
    citedByLabel: translations.citedByLabel || 'Cited by',
    siblingTypesLabel: translations.siblingTypesLabel || 'Related entity types',
    loadingContext: translations.loadingContext || 'Loading context...',
    failedContext: translations.failedContext || 'Failed to load context',
    search: translations.search || 'Search',
    cancel: translations.cancel || 'Cancel',
  };

  // Reset search term when modal opens
  useEffect(() => {
    if (isOpen) {
      setSearchTerm(initialSearchTerm);
    }
  }, [isOpen, initialSearchTerm]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!context) return;
    onSearch(searchTerm, context);
  };

  const sourceContext = context?.sourceContext;
  const graphContext = context?.graphContext;
  const entityTypes = context?.metadata?.entityTypes ?? [];
  const connections = graphContext?.connections ?? [];
  const citedBy = graphContext?.citedBy ?? [];
  const citedByCount = graphContext?.citedByCount ?? 0;
  const siblingEntityTypes = graphContext?.siblingEntityTypes ?? [];

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="semiont-search-modal semiont-search-modal--bind-context" onClose={onClose}>
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
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="semiont-bind-context">
                  {/* Source Context Preview */}
                  <div className="semiont-bind-context__section">
                    <label className="semiont-bind-context__label">
                      {t.sourceContextLabel}
                    </label>
                    {contextLoading && (
                      <div className="semiont-bind-context__loading">
                        {t.loadingContext}
                      </div>
                    )}
                    {!!contextError && (
                      <div className="semiont-bind-context__error">
                        {t.failedContext}
                      </div>
                    )}
                    {sourceContext && (
                      <div className="semiont-bind-context__passage">
                        {sourceContext.before && <span>{sourceContext.before}</span>}
                        <span className="semiont-bind-context__selected">
                          {sourceContext.selected}
                        </span>
                        {sourceContext.after && <span>{sourceContext.after}</span>}
                      </div>
                    )}
                  </div>

                  {/* Entity Types */}
                  {entityTypes.length > 0 && (
                    <div className="semiont-bind-context__section">
                      <label className="semiont-bind-context__label">
                        {t.entityTypesLabel}
                      </label>
                      <div className="semiont-bind-context__tags">
                        {entityTypes.map(et => (
                          <span key={et} className="semiont-bind-context__tag">{et}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Graph Context */}
                  {graphContext && (
                    <div className="semiont-bind-context__section">
                      <label className="semiont-bind-context__label">
                        {t.graphContextLabel}
                      </label>

                      {/* Connections */}
                      {connections.length > 0 && (
                        <div className="semiont-bind-context__subsection">
                          <span className="semiont-bind-context__sublabel">{t.connectionsLabel}</span>
                          <ul className="semiont-bind-context__list">
                            {connections.map(conn => (
                              <li key={conn.resourceId} className="semiont-bind-context__list-item">
                                <span className="semiont-bind-context__resource-name">{conn.resourceName}</span>
                                {conn.bidirectional && (
                                  <span className="semiont-bind-context__badge">mutual</span>
                                )}
                                {conn.entityTypes && conn.entityTypes.length > 0 && (
                                  <span className="semiont-bind-context__meta">
                                    {conn.entityTypes.join(', ')}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Cited By */}
                      {citedByCount > 0 && (
                        <div className="semiont-bind-context__subsection">
                          <span className="semiont-bind-context__sublabel">
                            {t.citedByLabel} ({citedByCount})
                          </span>
                          {citedBy.length > 0 && (
                            <ul className="semiont-bind-context__list">
                              {citedBy.map(ref => (
                                <li key={ref.resourceId} className="semiont-bind-context__list-item">
                                  {ref.resourceName}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      {/* Sibling Entity Types */}
                      {siblingEntityTypes.length > 0 && (
                        <div className="semiont-bind-context__subsection">
                          <span className="semiont-bind-context__sublabel">{t.siblingTypesLabel}</span>
                          <div className="semiont-bind-context__tags">
                            {siblingEntityTypes.map(et => (
                              <span key={et} className="semiont-bind-context__tag semiont-bind-context__tag--sibling">{et}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Editable Search Term */}
                  <div className="semiont-bind-context__section">
                    <label className="semiont-bind-context__label" htmlFor="bind-search-term">
                      {t.searchTermLabel}
                    </label>
                    <input
                      id="bind-search-term"
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder={t.searchTermPlaceholder}
                      className="semiont-search-modal__search-input"
                      autoFocus
                    />
                  </div>

                  {/* Action Buttons */}
                  <div className="semiont-bind-context__actions">
                    <button
                      type="button"
                      onClick={onClose}
                      className="semiont-button semiont-button--secondary"
                    >
                      {t.cancel}
                    </button>
                    <button
                      type="submit"
                      disabled={contextLoading || !context}
                      className="semiont-button semiont-button--primary"
                    >
                      {t.search}
                    </button>
                  </div>
                </form>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
