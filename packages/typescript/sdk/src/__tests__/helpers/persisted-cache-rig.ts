/**
 * The persisted-cache rig the cache property suites drive: two real persisted
 * caches over one storage, with the resumption bookmark coupled to their
 * document writes the way the session factory couples it.
 *
 * Cache A answers a fetch only when the suite resolves it (`resolvers`), so
 * the suite decides when a refetch completes. Cache B is the bystander: its
 * document write is what can flush a stashed bookmark.
 */

import type { ResourceId } from '@semiont/core';
import { createCache, type Cache } from '../../cache';
import { coupledLastEventId, sessionStoragePersister } from '../../cache-persister';
import type { InMemorySessionStorage } from '../../session/session-storage';

/** The one key cache A holds content under. */
export const KEY = 'res-1';
const A_DOC_KEY = 'semiont.cache.test.annotations';
const B_DOC_KEY = 'semiont.cache.test.entity-types';
export const BOOKMARK_KEY = 'semiont.lastEventId.test';
export const DEBOUNCE_MS = 50;

/** Content model: "the effect of every event ≤ upTo is present". */
export interface Content { upTo: number }

export interface Rig {
  cacheA: Cache<string, Content>;
  cacheB: Cache<string, Content>;
  saveLastEventId: (scope: ResourceId, id: string) => void;
  resolvers: Array<(c: Content) => void>;
  dispose: () => void;
}

/**
 * Build a client rig over (shared) storage — mirrors the factory wiring.
 * `gated` wires the quiescence gate (B17-Q) as the session factory does: the
 * bookmark may flush only when every persisted cache is quiet.
 */
export function buildRig(storage: InMemorySessionStorage, gated: boolean): Rig {
  const coupled = coupledLastEventId(storage, BOOKMARK_KEY);
  const resolvers: Array<(c: Content) => void> = [];

  const cacheA = createCache<string, Content>(
    () => new Promise<Content>((resolve) => { resolvers.push(resolve); }),
    {
      persister: sessionStoragePersister<string, Content>({
        storage: coupled.storage, storageKey: A_DOC_KEY, version: 1,
      }),
      saveDebounceMs: DEBOUNCE_MS,
    },
  );
  const cacheB = createCache<string, Content>(
    async () => ({ upTo: 0 }),
    {
      persister: sessionStoragePersister<string, Content>({
        storage: coupled.storage, storageKey: B_DOC_KEY, version: 1,
      }),
      saveDebounceMs: DEBOUNCE_MS,
    },
  );

  if (gated) {
    coupled.setFlushGate(() => !cacheA.persistencePending() && !cacheB.persistencePending());
  }

  return {
    cacheA, cacheB,
    saveLastEventId: coupled.saveLastEventId,
    resolvers,
    dispose: () => { cacheA.dispose(); cacheB.dispose(); },
  };
}

/** Read the persisted content document for A straight off storage. */
export function persistedAUpTo(storage: InMemorySessionStorage): number {
  const raw = storage.get(A_DOC_KEY);
  if (raw === null) return 0;
  const doc = JSON.parse(raw) as { entries: Array<[string, Content, number]> };
  return doc.entries.find(([k]) => k === KEY)?.[1].upTo ?? 0;
}

/** The sequence number of scope `r1`'s persisted bookmark; 0 when none is persisted. */
export function bookmarkSeq(storage: InMemorySessionStorage): number {
  const raw = storage.get(BOOKMARK_KEY);
  if (raw === null) return 0;
  const record = JSON.parse(raw) as Record<string, string>;
  const id = record['r1'];
  if (id === undefined) return 0;
  const m = /^p-r1-(\d+)$/.exec(id);
  if (!m) throw new Error(`unparseable bookmark ${id}`);
  return Number(m[1]);
}
