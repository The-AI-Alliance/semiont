/**
 * B17 — `CachePersister` backed by the `SessionStorage`
 * adapter seam. Environment-agnostic for the same reason the session layer
 * is: the browser passes its localStorage-backed adapter, a desktop host
 * passes its own, tests pass the in-memory one.
 *
 * What is kept is the queries protocol/specs/src/client/refresh.json marks
 * `persisted`, each its `value`; where, protocol/specs/src/session/stored.json's
 * `wholeKey`, `cacheDocument` and `lastEventIds`. Every SDK runs
 * protocol/specs/src/session/cache-cases.json against it. One document per
 * kept query:
 *   { version, entries: [[key, value, stamp], …] }
 *
 * - A document whose structure is not `cacheDocument`'s reads as nothing
 *   stored; an entry whose key or value is not its query's is skipped. A load
 *   never throws into the cache.
 * - An entry keeps its stamp while its value's JSON text is unchanged, so
 *   byte-cap eviction drops the entries received longest ago (not merely
 *   whatever a full-map re-save touched last).
 */

import { CACHE_VALUES, MAX_STORED_BYTES_COUNT, faultOf, isAnnotationId, isObject, isResourceId, isString } from '@semiont/core';
import type { AnnotationId, CachePer, CacheValues, PersistedQuery, ResourceId } from '@semiont/core';
import type { CachePersister } from './cache';
import type { SemiontClient } from './client';
import { SemiontSessionError } from './session/errors';
import type { SessionStorage } from './session/session-storage';
import type { SignInKept } from './session/sign-in-kept';
import { cacheKey, lastEventIdKey, personKey, type StoredSession } from './session/storage';

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

const isPlace = (json: unknown): json is string => faultOf('PersistedEventId', json) === undefined;

/** The key of each kind of query's entries: what refresh.json says it is asked for per. */
interface KeyPer {
  resource: ResourceId;
  annotation: AnnotationId;
  whole: WholeKey;
}

/** What the kept query `Q`'s entries are keyed by. */
export type KeptKey<Q extends PersistedQuery> = KeyPer[CachePer[Q]];

/**
 * Whether a value is what the kept query `query`'s cache holds, held as every
 * reply is: the component its value is, holding it member within member, has
 * no fault. Exact for a kept query, each member being all that holds it
 * requires (the generator refuses a persisted value that is not).
 */
const holdsValue = <Q extends PersistedQuery>(query: Q) => {
  const { component } = CACHE_VALUES[query];
  const members: readonly string[] = CACHE_VALUES[query].members;
  return (json: unknown): json is CacheValues[Q] =>
    faultOf(component, members.reduceRight<unknown>((inner, member) => ({ [member]: inner }), json)) === undefined;
};

const resourceIdKey = (json: unknown): json is ResourceId => isString(json) && isResourceId(json);
const annotationIdKey = (json: unknown): json is AnnotationId => isString(json) && isAnnotationId(json);
const wholeKey = (json: unknown): json is WholeKey => json === WHOLE_KEY;

/** How each kept query's entries are read back. */
export const KEPT_QUERIES: { [Q in PersistedQuery]: EntryDecoder<KeptKey<Q>, CacheValues[Q]> } = {
  resource: { key: resourceIdKey, value: holdsValue('resource') },
  annotations: { key: resourceIdKey, value: holdsValue('annotations') },
  annotation: { key: annotationIdKey, value: holdsValue('annotation') },
  entityTypes: { key: wholeKey, value: holdsValue('entityTypes') },
  tagSchemas: { key: wholeKey, value: holdsValue('tagSchemas') },
};

/**
 * B17 — the stream's places, carried by the kept caches' writes
 * (`coupledLastEventId`).
 */
export interface CoupledPlaces {
  /** Hand THIS to `cachePersistence`: its writes carry the places forward. */
  readonly storage: SessionStorage;
  /** The place reached in `scope`, written with a later cache-document write. */
  saveLastEventId(scope: ResourceId, id: string): void;
  loadLastEventIds(): ReadonlyMap<ResourceId, string> | null;
  /**
   * B17-Q (C1) — couple the places to what `client` keeps. Write-ordering
   * alone couples write MOMENTS, not content: doc B's save could carry a
   * place whose event doc A has not yet absorbed (mid-refetch, mid-debounce,
   * or owed by the refresher's window). Coupled, a cache-document write
   * carries the places only while the client's persistence is settled
   * (`browse.persistenceSettled()`); otherwise they stay pending, lagging,
   * the safe direction, and ride the next quiet write. The client's
   * `dispose()` reads that once, before it disposes anything: what is pending
   * then is all that is written after, and none at all unless no kept cache
   * was fetching and the refresher owed no refetch. Uncoupled, every
   * cache-document write carries the places.
   */
  coupleTo(client: SemiontClient): void;
}

/**
 * B17 — each client's coupled places, as its disposal seals them: written by
 * `coupleTo`, read by `sealPlaces`. Held here rather than on the client, so
 * that coupling is no part of the client's surface.
 */
const sealsOf = new WeakMap<SemiontClient, (atRest: boolean) => void>();

/**
 * B17 — `client`'s disposal reads once whether what it keeps is at rest,
 * before anything is disposed: the places coupled to it, if any, are sealed
 * with that reading. The places noted then are all that is written after,
 * and none at all unless it was at rest.
 */
export function sealPlaces(client: SemiontClient, atRest: boolean): void {
  const seal = sealsOf.get(client);
  if (seal !== undefined) seal(atRest);
}

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
 * direction. A document write the storage refuses carries no place.
 *
 * One connection holds many resource scopes, so watermarks are PER SCOPE:
 * `lastEventIds` under `lastEventIdKey`, each a resource's id to a
 * PersistedEventId.
 */
export function coupledLastEventId(storage: SessionStorage, lastEventIdKey: string): CoupledPlaces {
  const pending = new Map<ResourceId, string>();
  /** Whether what the coupled client keeps is at rest; null while the places are coupled to none. */
  let atRest: (() => boolean) | null = null;
  /** Whether the client's disposal has read `atRest`: what is pending then is all that is written. */
  let sealed = false;
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
    if (pending.size === 0 || (!sealed && atRest !== null && !atRest())) return;
    const merged = new Map([...readStored(), ...pending]);
    storage.set(lastEventIdKey, JSON.stringify(Object.fromEntries(merged)));
    pending.clear();
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
    // An id that is no PersistedEventId is no place, and one reached after
    // the client's disposal read the gate is of an event whose refetch
    // disposal drops: neither is kept.
    saveLastEventId: (scope, id) => {
      if (!sealed && isPlace(id)) pending.set(scope, id);
    },
    loadLastEventIds: () => {
      const stored = readStored();
      return stored.size > 0 ? stored : null;
    },
    coupleTo: (client) => {
      if (sealsOf.has(client)) throw new Error('A client is coupled to the places of one person');
      atRest = () => client.browse.persistenceSettled();
      sealsOf.set(client, (settled) => {
        if (sealed) return;
        sealed = true;
        if (!settled) pending.clear();
      });
    },
  };
}

/** B17 — what a session keeps for one person: the stream's places, and the caches, whose writes carry them. */
export interface Keeping {
  readonly places: CoupledPlaces;
  readonly persistence: CachePersistence;
}

/**
 * B17 — what a session over HTTP keeps, in a storage, for the person its kept
 * sign-in names (`personKeeping`): from the start when the sign-in names them,
 * otherwise from when the gateway names them, and nothing before.
 */
export interface PersonKeeping {
  /**
   * What keeps from the start, the sign-in naming the person as the session
   * is made: the client is made with its `persistence`, the transport loads
   * its places, and they are coupled to the client once it is made. Null when
   * the sign-in names nobody yet.
   */
  readonly fromStart: Keeping | null;
  /** The transport's places, each to what keeps once something does. */
  saveLastEventId(scope: ResourceId, id: string): void;
  /**
   * The gateway said `token` is the person `did` names. Their key is recorded
   * on the kept sign-in while it still holds `token`, and a session keeping
   * nothing yet keeps for them from now on: the places coupled to `client`,
   * its kept caches attached, and `transport` given the places kept for the
   * scopes it holds none for.
   */
  named(
    token: string,
    did: string,
    client: SemiontClient,
    transport: { restoreLastEventIds(places: ReadonlyMap<ResourceId, string>): void },
  ): void;
}

/**
 * B17 — what a session over the sign-in `kept` keeps on the knowledge base
 * `kbId`, in `storage`, for the person the sign-in names: written only while
 * it names them (`whileSignedIn`), the places carried by the caches' writes.
 * A sign-in that cannot be read before a save is told to `keepFailed` once,
 * as `session.keep-failed`: the client keeps nothing more.
 */
export function personKeeping(
  storage: SessionStorage,
  kbId: string,
  kept: SignInKept,
  keepFailed: (error: SemiontSessionError) => void,
): PersonKeeping {
  const unreadable = (cause: unknown): void => {
    const why = cause instanceof Error ? cause.message : String(cause);
    keepFailed(new SemiontSessionError(
      'session.keep-failed',
      `The sign-in could not be read before what the client keeps was saved, so it keeps nothing more: ${why}`,
      kbId,
    ));
  };
  const keepingFor = (person: string): Keeping => {
    const places = coupledLastEventId(whileSignedIn(storage, kept, person, unreadable), lastEventIdKey(kbId, person));
    return { places, persistence: { storage: places.storage, kbId, personKey: person } };
  };
  const named = kept.held()?.personKey;
  const fromStart = named === undefined ? null : keepingFor(named);
  let keeping = fromStart;
  return {
    fromStart,
    saveLastEventId: (scope, id) => {
      if (keeping !== null) keeping.places.saveLastEventId(scope, id);
    },
    named: (token, did, client, transport) => {
      const person = personKey(did);
      if (!kept.recordPersonKey(token, person) || keeping !== null) return;
      const begun = keepingFor(person);
      keeping = begun;
      begun.places.coupleTo(client);
      client.browse.attachPersistence(begun.persistence);
      const places = begun.places.loadLastEventIds();
      if (places !== null) transport.restoreLastEventIds(places);
    },
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
export function keptPersister<Q extends PersistedQuery>(
  query: Q,
  persistence: CachePersistence,
): CachePersister<KeptKey<Q>, CacheValues[Q]> {
  return sessionStoragePersister({
    storage: persistence.storage,
    storageKey: cacheKey(persistence.kbId, persistence.personKey, query),
    decode: KEPT_QUERIES[query],
  });
}
