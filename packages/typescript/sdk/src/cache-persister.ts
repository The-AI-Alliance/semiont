/**
 * B17 — `CachePersister` backed by the `SessionStorage`
 * adapter seam. Environment-agnostic for the same reason the session layer
 * is: the browser passes its localStorage-backed adapter, a desktop host
 * passes its own, tests pass the in-memory one.
 *
 * What is kept, and where, is protocol/specs/src/session/stored.json's
 * `keptQueries`, `wholeKey`, `cacheDocument` and `lastEventIds`; every SDK
 * runs protocol/specs/src/session/cache-cases.json against it. One document
 * per kept query:
 *   { version, entries: [[key, value, stamp], …] }
 *
 * - A document whose structure is not `cacheDocument`'s reads as nothing
 *   stored; an entry whose key or value is not its query's is skipped. A load
 *   never throws into the cache.
 * - An entry keeps its stamp while its value's JSON text is unchanged, so
 *   byte-cap eviction drops the entries received longest ago (not merely
 *   whatever a full-map re-save touched last).
 */

import { MAX_STORED_BYTES_COUNT, faultOf, isAnnotationId, isObject, isResourceId, isString } from '@semiont/core';
import type { AnnotationId, ResourceId, components } from '@semiont/core';
import type { CachePersister } from './cache';
import type { SessionStorage } from './session/session-storage';
import type { SignInKept } from './session/sign-in-kept';
import { cacheKey, type StoredSession } from './session/storage';

/**
 * B17 — where a client keeps its persisted queries' values: a store, under
 * the keys of one knowledge base and one person
 * (protocol/specs/src/session/stored.json, `cacheKeyPrefix`).
 */
export interface CachePersistence {
  readonly storage: SessionStorage;
  readonly kbId: string;
  /** The person's key, as `personKey` makes it of the did the gateway answered. */
  readonly personKey: string;
}

/**
 * `storage`, written for one person only while the sign-in `kept` holds names
 * them, as `kept` says before each write. Once it does not (the sign-in was
 * forgotten, here or in another context, or another sign-in replaced it), it
 * writes nothing more for its life: what was about to be written, a debounced
 * save or a stream's place, belongs to a sign-in that is gone, and must not
 * put back what forgetting it deleted. A renewal keeps the person, so writes
 * go on through it. A sign-in that cannot be read counts as one that no
 * longer names the person, and `unreadable` is told of it once, as it
 * happens. A write `storage` refuses is its own failure, and is let through.
 */
export function whileSignedIn(
  storage: SessionStorage,
  kept: SignInKept,
  personKey: string,
  unreadable: (cause: unknown) => void,
): SessionStorage {
  let signedOut = false;
  const signedIn = (): boolean => {
    if (signedOut) return false;
    let held: StoredSession | null;
    try {
      held = kept.held();
    } catch (cause) {
      signedOut = true;
      unreadable(cause);
      return false;
    }
    if (held === null || held.personKey !== personKey) signedOut = true;
    return !signedOut;
  };
  return {
    get: (k) => storage.get(k),
    set: (k, v) => {
      if (signedIn()) storage.set(k, v);
    },
    delete: (k) => {
      if (signedIn()) storage.delete(k);
    },
    update: (k, change) => {
      if (signedIn()) storage.update(k, change);
    },
    subscribe: (handler) => storage.subscribe(handler),
  };
}

/** The form of a kept query's document: `cacheDocument`'s `version`. */
export const CACHE_DOCUMENT_VERSION = 1;

/** The key a query per nothing keeps its one entry under: `wholeKey`. */
export const WHOLE_KEY = '_';
export type WholeKey = typeof WHOLE_KEY;

/** How a document's entry is read back: its key and its value, each held to what the document keeps. */
export interface EntryDecoder<K extends string, V> {
  key(json: unknown): json is K;
  value(json: unknown): json is V;
}

type Schemas = components['schemas'];

/** Whether a value is a `component`, held as every reply is: it has no fault. */
const holds = <C extends keyof Schemas>(component: C) =>
  (json: unknown): json is Schemas[C] => faultOf(component, json) === undefined;

/** Whether a value is `component`'s `member`, held as that component holding it alone. */
const holdsAs = <C extends keyof Schemas, M extends keyof Schemas[C] & string>(component: C, member: M) =>
  (json: unknown): json is Schemas[C][M] => faultOf(component, { [member]: json }) === undefined;

const isPlace = holds('PersistedEventId');

/** Each kept query, by its name in protocol/specs/src/client/refresh.json: the key and the value of its entries. */
interface KeptEntries {
  resource: [ResourceId, Schemas['ResourceDescriptor']];
  annotations: [ResourceId, Schemas['GetAnnotationsResponse']];
  annotation: [AnnotationId, Schemas['Annotation']];
  entityTypes: [WholeKey, Schemas['GetEntityTypesResponse']['entityTypes']];
  tagSchemas: [WholeKey, Schemas['GetTagSchemasResponse']['tagSchemas']];
}
export type KeptQuery = keyof KeptEntries;
export type KeptKey<Q extends KeptQuery> = KeptEntries[Q][0];
export type KeptValue<Q extends KeptQuery> = KeptEntries[Q][1];

const resourceIdKey = (json: unknown): json is ResourceId => isString(json) && isResourceId(json);
const annotationIdKey = (json: unknown): json is AnnotationId => isString(json) && isAnnotationId(json);
const wholeKey = (json: unknown): json is WholeKey => json === WHOLE_KEY;

/** `keptQueries`: how each kept query's entries are read back. */
export const KEPT_QUERIES: { [Q in KeptQuery]: EntryDecoder<KeptKey<Q>, KeptValue<Q>> } = {
  resource: { key: resourceIdKey, value: holds('ResourceDescriptor') },
  annotations: { key: resourceIdKey, value: holds('GetAnnotationsResponse') },
  annotation: { key: annotationIdKey, value: holds('Annotation') },
  entityTypes: { key: wholeKey, value: holdsAs('GetEntityTypesResponse', 'entityTypes') },
  tagSchemas: { key: wholeKey, value: holdsAs('GetTagSchemasResponse', 'tagSchemas') },
};

/**
 * B17 — couple the resumption bookmarks to the cache flush.
 *
 * The persisted watermarks audit the persisted cache documents: on reload
 * the client resumes each scope's replay from its watermark, so any event
 * at-or-before it whose effect is NOT in the persisted caches would be
 * silently skipped. Writing ids immediately per event creates exactly
 * that hazard (a crash inside the refetch + save-debounce window
 * persists a bookmark ahead of the caches). Instead: `saveLastEventId`
 * only STASHES the id under its scope; the wrapped storage writes the
 * whole record through — document first, ids second — on the next
 * cache-document write. The persisted ids may therefore LAG the caches
 * (harmless: replay re-invalidates idempotently) but can never lead them.
 * A crash between the two writes leaves the ids lagging — the safe
 * direction.
 *
 * One connection holds many resource scopes, so watermarks are PER SCOPE:
 * `lastEventIds` under `lastEventIdKey`, each a resource's id to a
 * PersistedEventId.
 */
export function coupledLastEventId(
  storage: SessionStorage,
  lastEventIdKey: string,
): {
  /** Hand THIS to `cachePersistence` — its writes carry the bookmarks forward. */
  storage: SessionStorage;
  saveLastEventId: (scope: ResourceId, id: string) => void;
  loadLastEventIds: () => ReadonlyMap<ResourceId, string> | null;
  /**
   * B17-Q (C1) — quiescence-gate the flush. Write-ordering alone couples
   * write MOMENTS, not content: doc B's save can flush a bookmark whose
   * event doc A has not yet absorbed (mid-refetch, mid-debounce, or owed by
   * the refresher's window). With a gate (wired by the session factory to
   * `browse.persistenceSettled()`), a cache-document write carries the
   * pending ids through only when that is settled; otherwise the ids stay
   * pending — lagging, the safe direction — and ride the next quiet write.
   */
  setFlushGate: (gate: () => boolean) => void;
} {
  const pending = new Map<ResourceId, string>();
  let flushGate: (() => boolean) | null = null;
  const readStored = (): Map<ResourceId, string> => {
    const stored = new Map<ResourceId, string>();
    const raw = storage.get(lastEventIdKey);
    if (raw === null) return stored;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return stored;
    }
    if (!isObject(parsed)) return stored;
    for (const [scope, id] of Object.entries(parsed)) {
      if (isResourceId(scope) && isPlace(id)) stored.set(scope, id);
    }
    return stored;
  };
  const flush = (): void => {
    if (pending.size > 0 && (flushGate === null || flushGate())) {
      const merged = new Map([...readStored(), ...pending]);
      storage.set(lastEventIdKey, JSON.stringify(Object.fromEntries(merged)));
      pending.clear();
    }
  };
  const coupled: SessionStorage = {
    get: (k) => storage.get(k),
    set: (k, v) => {
      storage.set(k, v);
      flush();
    },
    delete: (k) => storage.delete(k),
    update: (k, change) => {
      storage.update(k, change);
      flush();
    },
    subscribe: (handler) => storage.subscribe(handler),
  };
  return {
    storage: coupled,
    // An id that is no PersistedEventId is no place, and is never kept.
    saveLastEventId: (scope, id) => {
      if (isPlace(id)) pending.set(scope, id);
    },
    loadLastEventIds: () => {
      const stored = readStored();
      return stored.size > 0 ? stored : null;
    },
    setFlushGate: (gate) => { flushGate = gate; },
  };
}

type StoredEntry = [unknown, unknown, number];

const isStoredEntry = (entry: unknown): entry is StoredEntry =>
  Array.isArray(entry) && entry.length === 3 && Number.isInteger(entry[2]) && entry[2] >= 0;

/** A document's entries, or null when its structure is not `cacheDocument`'s, which keeps none of it. */
function storedEntries(raw: string | null): StoredEntry[] | null {
  if (raw === null) return null;
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(document) || document['version'] !== CACHE_DOCUMENT_VERSION) return null;
  const entries: unknown = document['entries'];
  if (!Array.isArray(entries) || !entries.every(isStoredEntry)) return null;
  return entries;
}

export function sessionStoragePersister<K extends string, V>(opts: {
  /** The environment's storage adapter — the seam, and the test seam. */
  storage: SessionStorage;
  /** Full storage key; callers scope it per KB and person (`cacheKey(kbId, personKey, query)`). */
  storageKey: string;
  /** What an entry read back must be; one that is not is skipped. */
  decode: EntryDecoder<K, V>;
  /** Byte cap for the document's UTF-8 text; oldest-stamped entries evicted first. Absent, `MAX_STORED_BYTES_COUNT`. */
  maxBytes?: number;
}): CachePersister<K, V> {
  const { storage, storageKey, decode } = opts;
  const maxBytes = opts.maxBytes ?? MAX_STORED_BYTES_COUNT;

  /**
   * Prior stamps, by key. Seeded by load(), refreshed by save() — an
   * unchanged value keeps its stamp so eviction order reflects when each
   * value was received.
   */
  let stamps = new Map<K, { valueJson: string; at: number }>();

  return {
    load(): Map<K, V> | null {
      const entries = storedEntries(storage.get(storageKey));
      if (entries === null) return null;
      const kept = entries.filter((entry): entry is [K, V, number] => decode.key(entry[0]) && decode.value(entry[1]));
      stamps = new Map(kept.map(([key, value, at]) => [key, { valueJson: JSON.stringify(value), at }]));
      return new Map(kept.map(([key, value]) => [key, value]));
    },

    save(entries: Map<K, V>): void {
      const now = Date.now();
      let records: Array<[K, V, number]> = [];
      const nextStamps = new Map<K, { valueJson: string; at: number }>();

      for (const [key, value] of entries) {
        const valueJson = JSON.stringify(value);
        const prior = stamps.get(key);
        const at = prior !== undefined && prior.valueJson === valueJson ? prior.at : now;
        nextStamps.set(key, { valueJson, at });
        records.push([key, value, at]);
      }

      // Byte-cap eviction: drop oldest-stamped entries until the document
      // fits. Measured in real UTF-8 bytes (the option's name tells the
      // truth): `.length` counts UTF-16 code units, which skews up to 3×
      // for non-ASCII values. localStorage itself accounts in code units,
      // so for that substrate the byte cap is conservative — acceptable
      // for a guard rail.
      const text = (list: Array<[K, V, number]>): string => JSON.stringify({ version: CACHE_DOCUMENT_VERSION, entries: list });
      const encoder = new TextEncoder();
      const documentSize = (list: Array<[K, V, number]>): number => encoder.encode(text(list)).length;
      if (documentSize(records) > maxBytes) {
        records = [...records].sort((a, b) => a[2] - b[2]);
        while (records.length > 0 && documentSize(records) > maxBytes) {
          const [evicted] = records.splice(0, 1);
          if (evicted) nextStamps.delete(evicted[0]);
        }
      }

      stamps = nextStamps;
      storage.set(storageKey, text(records));
    },
  };
}

/** The persister of the kept query `query`, under its key in `persistence`: its knowledge base's, its person's and the query's (`cacheKeyPrefix`). */
export function keptPersister<Q extends KeptQuery>(
  query: Q,
  persistence: CachePersistence,
): CachePersister<KeptKey<Q>, KeptValue<Q>> {
  return sessionStoragePersister({
    storage: persistence.storage,
    storageKey: cacheKey(persistence.kbId, persistence.personKey, query),
    decode: KEPT_QUERIES[query],
  });
}
