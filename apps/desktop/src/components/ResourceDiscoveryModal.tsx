import { useEffect, useMemo, useRef, useState } from 'react';
import { ResourceCard, useObservable } from '@semiont/react-ui';
import type { ResourceDescriptor } from '@semiont/core';
import type { ChatSession } from '../lib/session';
import { isDirectKbDirectory, normalizeKbDirectory } from '../lib/kb-location';

const RESULT_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 250;

type DirectoryEntry = Awaited<ReturnType<ChatSession['client']['browse']['files']>>['entries'][number];
type Directory = Extract<DirectoryEntry, { type: 'dir' }>;
type FileEntry = Extract<DirectoryEntry, { type: 'file' }>;
type TrackedFileEntry = FileEntry & { tracked: true; resourceId: string };

type DirectoryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: DirectoryEntry[] }
  | { status: 'failed'; message: string };

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
  const [view, setView] = useState<'search' | 'folders'>('search');
  const [directory, setDirectory] = useState('');
  const [directoryState, setDirectoryState] = useState<DirectoryState>({ status: 'loading' });
  const [directoryRetry, setDirectoryRetry] = useState(0);

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
  const recentSource = useMemo(() => view === 'search' ? session.client.browse.resources({
    limit: RESULT_LIMIT,
    archived: false,
    ...(selectedEntityType ? { entityType: selectedEntityType } : {}),
  }) : null, [session, selectedEntityType, view]);
  const recentState = useObservable(recentSource);
  const searchSource = useMemo(() => view === 'search' && debouncedQuery
    ? session.client.match.resources(debouncedQuery, {
      limit: RESULT_LIMIT,
      archived: false,
      ...(selectedEntityType ? { entityType: selectedEntityType } : {}),
    })
    : null, [session, debouncedQuery, selectedEntityType, view]);
  const searchState = useObservable(searchSource);

  useEffect(() => {
    if (view !== 'folders') return undefined;
    let current = true;
    setDirectoryState({ status: 'loading' });
    void session.client.browse.files(directory === '' ? undefined : directory, 'name').then((result) => {
      if (current) setDirectoryState({ status: 'ready', entries: result.entries });
    }).catch((error: unknown) => {
      if (current) setDirectoryState({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return () => { current = false; };
  }, [session, view, directory, directoryRetry]);

  const entityTypes = entityTypesState?.status === 'ready' ? entityTypesState.value : [];
  const displayingSearch = view === 'search' && query.trim().length > 0;
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
    if (recentSource !== null) void recentSource.fresh().catch(() => undefined);
  };

  const openResource = (resource: ResourceDescriptor) => {
    const id = String(resource['@id']);
    onOpenResource(id, resource.name ?? id);
  };

  const directories: Directory[] = directoryState.status === 'ready'
    ? directoryState.entries.filter((entry): entry is Directory => entry.type === 'dir' && isDirectKbDirectory(directory, entry.path))
    : [];
  const files: TrackedFileEntry[] = directoryState.status === 'ready'
    ? directoryState.entries.filter((entry): entry is TrackedFileEntry => entry.type === 'file' && entry.tracked && entry.resourceId !== undefined)
      .filter((entry) => selectedEntityType === '' || entry.entityTypes?.includes(selectedEntityType) === true)
      .filter((entry) => query.trim() === '' || entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : [];
  const breadcrumbs = [
    { name: 'KB root', path: '' },
    ...directory.split('/').filter(Boolean).map((segment, index, parts) => ({
      name: segment,
      path: parts.slice(0, index + 1).join('/'),
    })),
  ];

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
            <div className="discover-modal__toolbar">
              <div className="discover-modal__view-switch" role="group" aria-label="Resource discovery view">
                <button
                  type="button"
                  aria-pressed={view === 'search'}
                  data-active={view === 'search'}
                  onClick={() => setView('search')}
                >
                  Search
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'folders'}
                  data-active={view === 'folders'}
                  onClick={() => setView('folders')}
                >
                  Browse folders
                </button>
              </div>

              <div className="semiont-card__search-form">
                <div className="semiont-card__search-wrapper">
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={view === 'search' ? 'Search resources by name or content…' : 'Filter this folder by filename…'}
                    className="semiont-card__search-input"
                    aria-label={view === 'search' ? 'Search resources by name or content' : 'Filter this folder by filename'}
                  />
                  {displayingSearch && isSearching && (
                    <span className="semiont-card__search-status" role="status">Searching…</span>
                  )}
                </div>
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

            {view === 'folders' ? (
              <section className="discover-folders" aria-label="Browse resources by folder">
                <nav className="discover-folders__breadcrumbs" aria-label="Knowledge Base folder path">
                  {breadcrumbs.map((crumb, index) => (
                    <span className="discover-folders__crumb-wrap" key={crumb.path || 'root'}>
                      {index > 0 && <span aria-hidden="true">/</span>}
                      <button
                        type="button"
                        className="discover-folders__crumb"
                        aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined}
                        onClick={() => setDirectory(normalizeKbDirectory(crumb.path) ?? '')}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </nav>
                <div className="discover-folders__list" aria-live="polite">
                  {directoryState.status === 'loading' && <p className="discover-modal__message" role="status">Loading folder…</p>}
                  {directoryState.status === 'failed' && (
                    <div className="discover-folders__error" role="alert">
                      <p>Could not list this folder: {directoryState.message}</p>
                      <button type="button" className="semiont-button" data-variant="secondary" onClick={() => setDirectoryRetry((value) => value + 1)}>Retry</button>
                    </div>
                  )}
                  {directoryState.status === 'ready' && directories.length === 0 && files.length === 0 && (
                    <p className="discover-modal__message">
                      {directoryState.entries.length === 0
                        ? 'This folder is empty.'
                        : 'No resources match the current filters in this folder.'}
                    </p>
                  )}
                  {directories.map((entry) => (
                    <button
                      type="button"
                      className="discover-folders__entry"
                      key={entry.path}
                      onClick={() => setDirectory(normalizeKbDirectory(entry.path) ?? '')}
                    >
                      <span aria-hidden="true">▸</span><span>{entry.name}</span><span aria-hidden="true">›</span>
                    </button>
                  ))}
                  {files.map((entry) => (
                    <button
                      type="button"
                      className="discover-folders__entry discover-folders__resource"
                      key={entry.path}
                      aria-label={`Open resource ${entry.name}`}
                      onClick={() => onOpenResource(entry.resourceId, entry.name)}
                    >
                      <span aria-hidden="true">▤</span>
                      <span className="discover-folders__resource-copy">
                        <strong>{entry.name}</strong>
                        <small>Modified {new Date(entry.mtime).toLocaleDateString()}</small>
                      </span>
                      <span className="discover-folders__tags">
                        {entry.entityTypes?.slice(0, 2).map((entityType) => <small key={entityType}>{entityType}</small>)}
                        {entry.annotationCount !== undefined && <small>{entry.annotationCount} annotations</small>}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : (
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
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
