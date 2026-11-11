/**
 * The persisted-cache rig the cache property suites drive: a real client whose kept caches persist
 * through one storage, with the stream's places carried by their document writes and, when `coupled`,
 * coupled to the client, as the session factory couples them.
 *
 * Cache A is the client's annotations of one resource. Its fetch answers only when the suite resolves it
 * (`resolvers`), so the suite decides when a refetch completes; its content, "the effect of every event
 * ≤ upTo is present", is held as that many annotations. Cache B is the bystander, the client's entity
 * types: its document write is what can flush a noted place.
 */

import { resourceId, type ResourceId, type components } from '@semiont/core';
import { coupledLastEventId } from '../../cache-persister';
import { cacheKey, lastEventIdKey, personKey } from '../../session/storage';
import type { InMemorySessionStorage } from '../../session/session-storage';
import { createTestClient, inMemoryContent, refuseUnscriptedOperation } from '../../testing';
import { mockAnnotation } from '../fixtures/annotation';

type GetAnnotationsResponse = components['schemas']['GetAnnotationsResponse'];

/** The knowledge base and the person the rig's client keeps for. */
const KB_ID = 'kb-rig';
const PERSON = personKey('did:web:example.org:users:jo');

/** The resource whose annotations cache A holds. */
const A_KEY = resourceId('res-1');
const A_DOC_KEY = cacheKey(KB_ID, PERSON, 'annotations');
export const BOOKMARK_KEY = lastEventIdKey(KB_ID, PERSON);

/** Content model: "the effect of every event ≤ upTo is present". */
export interface Content { upTo: number }

/** A's value holding the effect of every event ≤ upTo: that many annotations. */
function annotationsUpTo({ upTo }: Content): GetAnnotationsResponse {
  const annotations = Array.from({ length: upTo }, (_, i) => mockAnnotation(`ann-${i + 1}`));
  return { annotations, total: annotations.length };
}

export interface Rig {
  /** Observe A, as a resource open in a page does. */
  observeA: () => void;
  /** What A renders: the last event whose effect it shows; 0 before it shows any. */
  renderedA: () => number;
  /** An event's effect on A: its key invalidated, and its refetch asked. */
  invalidateA: () => void;
  /** The bystander changes: B is asked again and answered with a new value, whose save it then owes. */
  changeB: () => void;
  saveLastEventId: (scope: ResourceId, id: string) => void;
  resolvers: Array<(c: Content) => void>;
  dispose: () => void;
}

/**
 * Build a client rig over (shared) storage, wired as the session factory wires one. `coupled` couples the
 * places to the client (B17-Q): a place is written only while every kept cache is quiet and the refresher
 * owes nothing. Uncoupled, every cache-document write carries the places noted.
 */
export function buildRig(storage: InMemorySessionStorage, coupled: boolean): Rig {
  const places = coupledLastEventId(storage, BOOKMARK_KEY);
  const resolvers: Array<(c: Content) => void> = [];
  let bAnswers = 0;
  const { client } = createTestClient({
    content: {
      ...inMemoryContent(),
      getAnnotations: () => new Promise<GetAnnotationsResponse>((resolve) => {
        resolvers.push((c) => resolve(annotationsUpTo(c)));
      }),
    },
    transport: {
      makeResponse: (operation) => {
        if (operation !== 'browse:entity-types-requested') return refuseUnscriptedOperation(operation);
        bAnswers += 1;
        return { entityTypes: [`answer-${bAnswers}`] };
      },
    },
    cachePersistence: { storage: places.storage, kbId: KB_ID, personKey: PERSON },
  });
  if (coupled) places.coupleTo(client);

  // B is observed from the start, so asking it again refetches it.
  client.browse.entityTypes().subscribe({ next: () => {}, error: () => {} });

  let rendered = 0;
  return {
    observeA: () => {
      client.browse.annotations(A_KEY).subscribe({
        next: (state) => {
          if (state.status === 'ready') rendered = state.value.length;
        },
        error: () => {},
      });
    },
    renderedA: () => rendered,
    invalidateA: () => client.browse.invalidateAnnotationList(A_KEY),
    changeB: () => client.browse.invalidateEntityTypes(),
    saveLastEventId: places.saveLastEventId,
    resolvers,
    dispose: () => client.dispose(),
  };
}

/** The event whose effect A's persisted document holds; 0 when none is persisted. */
export function persistedAUpTo(storage: InMemorySessionStorage): number {
  const raw = storage.get(A_DOC_KEY);
  if (raw === null) return 0;
  const doc = JSON.parse(raw) as { entries: Array<[string, GetAnnotationsResponse, number]> };
  return doc.entries.find(([k]) => k === A_KEY)?.[1].total ?? 0;
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
