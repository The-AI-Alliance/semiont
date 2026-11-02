import { useCallback, useEffect, useMemo, useState } from 'react';
import { useObservable } from '@semiont/react-ui';
import type { ResourceDescriptor } from '@semiont/core';
import { QUESTION_ENTITY_TYPE, type ChatSession } from '../lib/session';

// Matches the monorepo discover page: full-text search via `browse.resources({ search })`,
// debounced, capped at 20 hits.
const SEARCH_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 250;

/** Debounce a changing value so a search doesn't fire on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const notQuestion = (r: ResourceDescriptor) => !(r.entityTypes ?? []).includes(QUESTION_ENTITY_TYPE);

/** The clickable document rows, shared by the live list and search results. */
function DocRows({
  docs,
  activeResourceId,
  onOpen,
}: {
  docs: ResourceDescriptor[];
  activeResourceId: string | null;
  onOpen: (id: string, name: string) => void;
}) {
  return (
    <ul className="kb__docs">
      {docs.map((doc) => {
        const id = String(doc['@id']);
        const name = doc.name ?? id;
        const active = id === activeResourceId;
        return (
          <li key={id}>
            <button
              type="button"
              className={`kb__doc${active ? ' kb__doc--active' : ''}`}
              onClick={() => onOpen(id, name)}
              title="Open in this window"
            >
              {doc.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A connected KB's document panel. `browse.resources()` is a `CacheObservable` emitting
 * `CacheState` (pending → ready, or failed in-band — never a stream error): subscribing
 * replays the live cache (auto-updates while the bus delivers invalidations); `.fresh()`
 * does a one-shot backend fetch. A bump of `refreshSignal` triggers a fresh fetch. When
 * `searchOpen`, a search box shows; a non-empty query switches the panel to live results
 * (`SearchResults`). Question resources are hidden throughout.
 */
export function KbResources({
  session,
  searchOpen,
  refreshSignal,
  activeResourceId,
  onOpen,
}: {
  session: ChatSession;
  /** When true, show the search box; a non-empty query replaces the list with results. */
  searchOpen: boolean;
  refreshSignal: number;
  /** The open document's id, so its row shows as active (purple). */
  activeResourceId: string | null;
  /** Open a document in the main pane (highlighting its row purple). */
  onOpen: (id: string, name: string) => void;
}) {
  const liveState = useObservable(useMemo(() => session.client.browse.resources(), [session]));
  const live = liveState?.status === 'ready' ? liveState.value.resources : undefined;
  const [fresh, setFresh] = useState<ResourceDescriptor[] | null>(null);
  useEffect(() => setFresh(null), [liveState]); // a live re-emit supersedes the manual fetch

  const refresh = useCallback(async () => {
    try {
      setFresh((await session.client.browse.resources().fresh()).resources);
    } catch {
      // keep whatever is shown
    }
  }, [session]);
  useEffect(() => {
    if (refreshSignal > 0) void refresh();
  }, [refreshSignal, refresh]);

  // Search box + entity-type facet (only while open). A non-empty debounced query OR a selected
  // type switches the panel from the live list to filtered results.
  const entityTypesState = useObservable(useMemo(() => session.client.browse.entityTypes(), [session]));
  const entityTypes = entityTypesState?.status === 'ready' ? entityTypesState.value : [];
  const facetTypes = entityTypes.filter((t) => t !== QUESTION_ENTITY_TYPE);
  const [query, setQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string | null>(null);
  useEffect(() => {
    if (!searchOpen) {
      setQuery('');
      setSelectedType(null);
    }
  }, [searchOpen]);
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS).trim();
  const filtering = searchOpen && (debounced.length > 0 || selectedType !== null);

  const resources = fresh ?? live;
  const docs = (resources ?? []).filter(notQuestion);

  return (
    <>
      {searchOpen && (
        <input
          className="kb__search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search documents…"
          aria-label="Search documents"
        />
      )}
      {searchOpen && facetTypes.length > 0 && (
        <select
          className="kb__facet"
          value={selectedType ?? ''}
          onChange={(e) => setSelectedType(e.target.value || null)}
          aria-label="Filter by entity type"
        >
          <option value="">All types</option>
          {facetTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
      {filtering ? (
        <SearchResults
          session={session}
          query={debounced}
          entityType={selectedType}
          activeResourceId={activeResourceId}
          onOpen={onOpen}
        />
      ) : resources === undefined ? (
        liveState?.status === 'failed' ? (
          // The failed state is in-band (CACHE-CONTRACT) — say so instead of loading forever.
          <p className="kb__status" role="alert">
            Couldn’t load documents: {liveState.error.message}
          </p>
        ) : (
          <p className="kb__status">Loading…</p>
        )
      ) : docs.length === 0 ? (
        <p className="kb__status">No documents.</p>
      ) : (
        <DocRows docs={docs} activeResourceId={activeResourceId} onOpen={onOpen} />
      )}
    </>
  );
}

/**
 * Live filtered document view — `browse.resources({ search?, entityType? })`, the same call the
 * monorepo's discover page uses (a `CacheObservable`, so results stay live as the bus invalidates).
 * Driven by a text query, a selected entity type, or both. All three `CacheState` outcomes render:
 * pending searches, failed says so, ready lists.
 */
function SearchResults({
  session,
  query,
  entityType,
  activeResourceId,
  onOpen,
}: {
  session: ChatSession;
  query: string;
  entityType: string | null;
  activeResourceId: string | null;
  onOpen: (id: string, name: string) => void;
}) {
  const resultsState = useObservable(
    useMemo(() => {
      const filters: { limit: number; archived: boolean; search?: string; entityType?: string } = {
        limit: SEARCH_LIMIT,
        archived: false,
      };
      if (query) filters.search = query;
      if (entityType) filters.entityType = entityType;
      return session.client.browse.resources(filters);
    }, [session, query, entityType]),
  );
  if (resultsState === undefined || resultsState.status === 'pending') {
    return <p className="kb__status">Searching…</p>;
  }
  if (resultsState.status === 'failed') {
    return (
      <p className="kb__status" role="alert">
        Search failed: {resultsState.error.message}
      </p>
    );
  }
  const docs = resultsState.value.resources.filter(notQuestion);
  if (docs.length === 0) {
    return <p className="kb__status">{query ? `No matches for “${query}”.` : `No “${entityType}” documents.`}</p>;
  }
  return <DocRows docs={docs} activeResourceId={activeResourceId} onOpen={onOpen} />;
}
