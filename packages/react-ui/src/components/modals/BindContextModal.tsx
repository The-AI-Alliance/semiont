'use client';

import React, { useState, useEffect } from 'react';
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
    <Transition appear show={isOpen}>
      <Dialog as="div" className="semiont-search-modal semiont-search-modal--bind-context" onClose={onClose}>
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
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="semiont-form">
                  {/* Source Context Preview */}
                  <div className="semiont-form__field">
                    <label className="semiont-form__label">
                      {t.sourceContextLabel}
                    </label>
                    {contextLoading && (
                      <div className="semiont-modal__empty-state" style={{ textAlign: 'center', padding: '1rem 0' }}>
                        {t.loadingContext}
                      </div>
                    )}
                    {!!contextError && (
                      <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--semiont-color-red-600)' }}>
                        {t.failedContext}
                      </div>
                    )}
                    {sourceContext && (
                      <div style={{
                        padding: '0.75rem',
                        backgroundColor: 'var(--semiont-bg-secondary)',
                        borderRadius: 'var(--semiont-radius-md)',
                        border: '1px solid var(--semiont-border-primary)',
                        maxHeight: '200px',
                        overflowY: 'auto',
                      }}>
                        <div style={{ fontSize: 'var(--semiont-text-sm)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                          {sourceContext.before && <span>{sourceContext.before}</span>}
                          <span style={{
                            backgroundColor: 'var(--semiont-color-primary-100)',
                            padding: '0 0.25rem',
                            fontWeight: 600,
                            color: 'var(--semiont-color-primary-900)',
                          }}>
                            {sourceContext.selected}
                          </span>
                          {sourceContext.after && <span>{sourceContext.after}</span>}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Entity Types */}
                  {entityTypes.length > 0 && (
                    <div className="semiont-form__field">
                      <label className="semiont-form__label">
                        {t.entityTypesLabel}
                      </label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                        {entityTypes.map(et => (
                          <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem' }}>
                            {et}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Graph Context */}
                  {graphContext && (connections.length > 0 || citedByCount > 0 || siblingEntityTypes.length > 0) && (
                    <div className="semiont-form__field">
                      <label className="semiont-form__label">
                        {t.graphContextLabel}
                      </label>
                      <div style={{
                        padding: '0.75rem',
                        backgroundColor: 'var(--semiont-bg-secondary)',
                        borderRadius: 'var(--semiont-radius-md)',
                        border: '1px solid var(--semiont-border-primary)',
                        fontSize: 'var(--semiont-text-sm)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                      }}>
                        {/* Connections */}
                        {connections.length > 0 && (
                          <div>
                            <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>{t.connectionsLabel}</span>
                            <ul style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.125rem', listStyle: 'none', padding: 0 }}>
                              {connections.map(conn => (
                                <li key={conn.resourceId} style={{ color: 'var(--semiont-text-secondary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                  <span>{conn.resourceName}</span>
                                  {conn.bidirectional && (
                                    <span className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem' }}>mutual</span>
                                  )}
                                  {conn.entityTypes && conn.entityTypes.length > 0 && (
                                    <span style={{ fontSize: 'var(--semiont-text-xs)', color: 'var(--semiont-text-tertiary)' }}>
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
                          <div>
                            <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>
                              {t.citedByLabel} ({citedByCount})
                            </span>
                            {citedBy.length > 0 && (
                              <ul style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.125rem', listStyle: 'none', padding: 0 }}>
                                {citedBy.map(ref => (
                                  <li key={ref.resourceId} style={{ color: 'var(--semiont-text-secondary)' }}>
                                    {ref.resourceName}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}

                        {/* Sibling Entity Types */}
                        {siblingEntityTypes.length > 0 && (
                          <div>
                            <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>{t.siblingTypesLabel}</span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.25rem' }}>
                              {siblingEntityTypes.map(et => (
                                <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem' }}>
                                  {et}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Editable Search Term */}
                  <div className="semiont-form__field">
                    <label className="semiont-form__label" htmlFor="bind-search-term">
                      {t.searchTermLabel}
                    </label>
                    <input
                      id="bind-search-term"
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder={t.searchTermPlaceholder}
                      className="semiont-input"
                      autoFocus
                    />
                  </div>

                  {/* Action Buttons */}
                  <div className="semiont-modal__actions" style={{ paddingTop: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={onClose}
                      className="semiont-button--secondary semiont-button--flex"
                    >
                      {t.cancel}
                    </button>
                    <button
                      type="submit"
                      disabled={contextLoading || !context}
                      className="semiont-button--primary semiont-button--flex"
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
