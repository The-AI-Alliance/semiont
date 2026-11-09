import { useEffect, useMemo, useRef, useState } from 'react';
import { ResourceCard, useObservable } from '@semiont/react-ui';
import type { ResourceDescriptor } from '@semiont/core';
import type { ChatSession } from '../lib/session';

const RESULT_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 250;

export function ResourceDiscoveryModal({
  session,
  onClose,
  onOpenResource,
}: {
  session: ChatSession;
  onClose: () => void;
  onOpenResource: (id: string, name: string) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedEntityType, setSelectedEntityType] = useState('');

  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const entityTypesState = useObservable(useMemo(() => session.client.browse.entityTypes(), [session]));
  const recentSource = useMemo(() => session.client.browse.resources({
    limit: RESULT_LIMIT,
    archived: false,
    ...(selectedEntityType ? { entityType: selectedEntityType } : {}),
  }), [session, selectedEntityType]);
  const recentState = useObservable(recentSource);
  const searchSource = useMemo(() => debouncedQuery
    ? session.client.match.resources(debouncedQuery, {
      limit: RESULT_LIMIT,
      archived: false,
      ...(selectedEntityType ? { entityType: selectedEntityType } : {}),
    })
    : null, [session, debouncedQuery, selectedEntityType]);
  const searchState = useObservable(searchSource);

  const entityTypes = entityTypesState?.status === 'ready' ? entityTypesState.value : [];
  const displayingSearch = query.trim().length > 0;
  const isSearching = displayingSearch && (
    query.trim() !== debouncedQuery || searchState === undefined || searchState.status === 'pending'
  );
  const recentDocuments = recentState?.status === 'ready' ? recentState.value.resources : [];
  const searchDocuments = searchState?.status === 'ready' ? searchState.value.resources : [];
  const visibleSearchDocuments = isSearching ? [] : searchDocuments;
  const documents = displayingSearch ? visibleSearchDocuments : recentDocuments;
  const recentError = recentState?.status === 'failed' ? recentState.error : null;
  const searchError = searchState?.status === 'failed' ? searchState.error : null;
  const matchKind = searchState?.status === 'ready' ? searchState.value.matchKind : undefined;

  const retryRecent = () => {
    void recentSource.fresh().catch(() => undefined);
  };

  const openResource = (resource: ResourceDescriptor) => {
    const id = String(resource['@id']);
    onOpenResource(id, resource.name ?? id);
  };

  return (
    <div className="modal modal--discover" onClick={() => closeRef.current()}>
      <section
        className="discover-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-discovery-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="discover-modal__header">
          <div>
            <h1 id="resource-discovery-title">Discover Resources</h1>
            <p>Explore this knowledge base and discover connections.</p>
          </div>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close resource search">
            ×
          </button>
        </header>

        <div className="discover-modal__content">
          <div className="semiont-card">
            <div className="semiont-card__search-form">
              <div className="semiont-card__search-wrapper">
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search resources by name or content…"
                  className="semiont-card__search-input"
                  aria-label="Search resources by name or content"
                />
                {displayingSearch && isSearching && (
                  <span className="semiont-card__search-status" role="status">Searching…</span>
                )}
              </div>
            </div>

            {entityTypes.length > 0 && (
              <div className="semiont-card__filters">
                <h2 className="semiont-card__filters-label">Filter by Entity Type</h2>
                <div className="semiont-card__filter-buttons" role="group" aria-label="Filter by entity type">
                  <button
                    type="button"
                    className="semiont-card__filter-button"
                    data-active={selectedEntityType === ''}
                    aria-pressed={selectedEntityType === ''}
                    onClick={() => setSelectedEntityType('')}
                  >
                    All
                  </button>
                  {entityTypes.map((entityType) => (
                    <button
                      type="button"
                      key={entityType}
                      className="semiont-card__filter-button"
                      data-active={selectedEntityType === entityType}
                      aria-pressed={selectedEntityType === entityType}
                      onClick={() => setSelectedEntityType(entityType)}
                    >
                      {entityType}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="semiont-card__documents">
              <h2 className="semiont-card__documents-label">
                {displayingSearch ? `Search Results${documents.length ? ` (${documents.length})` : ''}` : 'Recent Resources'}
              </h2>
              {displayingSearch && matchKind === 'semantic' && documents.length > 0 && (
                <p className="semiont-card__documents-note" aria-live="polite">
                  These resources matched by meaning because no exact text matches were found.
                </p>
              )}

              {displayingSearch && searchError ? (
                <p className="discover-modal__message" role="alert">Search failed: {searchError.message}</p>
              ) : !displayingSearch && recentError ? (
                <div className="semiont-card__warning" role="alert">
                  <p className="semiont-card__warning-text">Couldn’t load recent resources: {recentError.message}</p>
                  <button type="button" className="semiont-button" data-variant="secondary" onClick={retryRecent}>Retry</button>
                </div>
              ) : (displayingSearch ? isSearching : recentState === undefined || recentState.status === 'pending') ? (
                <p className="discover-modal__message" role="status">{displayingSearch ? 'Searching…' : 'Loading resources…'}</p>
              ) : documents.length > 0 ? (
                <div className="semiont-card-grid" role="group" aria-label="Resources">
                  {documents.map((resource) => (
                    <ResourceCard
                      key={String(resource['@id'])}
                      resource={resource}
                      onOpen={openResource}
                      archivedLabel="Archived"
                      createdLabel="Created"
                    />
                  ))}
                </div>
              ) : (
                <p className="discover-modal__message">
                  {displayingSearch ? `No results found for “${query.trim()}”.` : 'No resources are available in this knowledge base yet.'}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
