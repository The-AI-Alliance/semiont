import { useCallback, useEffect, useMemo, useState } from 'react';
import { useObservable } from '@semiont/react-ui';
import type { ResourceDescriptor } from '@semiont/core';
import { QUESTION_ENTITY_TYPE, type ChatSession } from '../lib/session';

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
 * does a one-shot backend fetch. A bump of `refreshSignal` triggers a fresh fetch. Question
 * resources are hidden throughout. Full-text discovery lives in the workspace modal.
 */
export function KbResources({
  session,
  refreshSignal,
  activeResourceId,
  onOpen,
}: {
  session: ChatSession;
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

  const resources = fresh ?? live;
  const docs = (resources ?? []).filter(notQuestion);

  return (
    <>
      {resources === undefined ? (
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
