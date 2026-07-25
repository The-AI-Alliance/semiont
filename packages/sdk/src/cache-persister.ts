/**
 * B17 (LOCAL-STORAGE) — `CachePersister` backed by the `SessionStorage`
 * adapter seam. Environment-agnostic for the same reason the session layer
 * is: the browser passes its localStorage-backed adapter, a desktop host
 * passes its own, tests pass the in-memory one.
 *
 * Stored document (all-or-nothing under one key):
 *   { version, writtenAt, entries: [[keyJson, value, entryWrittenAt], …] }
 *
 * - `version` gates load: mismatch or parse garbage reads as "nothing
 *   stored" — never throws into the cache.
 * - Per-entry `entryWrittenAt` stamps power byte-cap eviction: an entry
 *   keeps its stamp while its serialized value is unchanged, so eviction
 *   drops the entries that have gone longest without a write (not merely
 *   whatever a full-map re-save touched last).
 */

import type { CachePersister } from './cache';
import type { SessionStorage } from './session/session-storage';

/**
 * B17 — couple the resumption bookmark to the cache flush.
 *
 * The persisted `Last-Event-ID` audits the persisted cache documents: on
 * reload the client resumes replay from it, so any event at-or-before it
 * whose effect is NOT in the persisted caches would be silently skipped.
 * Writing the id immediately per event created exactly that hazard (a
 * crash inside the refetch + save-debounce window persisted a bookmark
 * ahead of the caches). Instead: `saveLastEventId` only STASHES the id;
 * the wrapped storage writes it through — document first, id second — on
 * the next cache-document write. The persisted id may therefore LAG the
 * caches (harmless: replay re-invalidates idempotently) but can never
 * lead them. A crash between the two writes leaves the id lagging — the
 * safe direction. Cross-resource cases need no coupling at all: a
 * scope-mismatched resume already yields `bus:resume-gap` → blanket
 * invalidation.
 */
export function coupledLastEventId(
  storage: SessionStorage,
  lastEventIdKey: string,
): {
  /** Hand THIS to `cachePersistence` — its writes carry the bookmark forward. */
  storage: SessionStorage;
  saveLastEventId: (id: string) => void;
  loadLastEventId: () => string | null;
  /**
   * B17-Q (C1) — quiescence-gate the flush. Write-ordering alone couples
   * write MOMENTS, not content: doc B's save could flush a bookmark whose
   * event doc A had not yet absorbed (mid-refetch or mid-debounce) — the
   * measured spec-14 bug. With a gate (wired by the session factory to
   * `browse.persistenceSettled()`), a cache-document write carries the
   * pending id through only when every persisted cache is quiet; otherwise
   * the id stays pending — lagging, the safe direction — and rides the next
   * quiet write.
   */
  setFlushGate: (gate: () => boolean) => void;
} {
  let pending: string | null = null;
  let flushGate: (() => boolean) | null = null;
  const coupled: SessionStorage = {
    get: (k) => storage.get(k),
    set: (k, v) => {
      storage.set(k, v);
      if (pending !== null && (flushGate === null || flushGate())) {
        storage.set(lastEventIdKey, pending);
        pending = null;
      }
    },
    delete: (k) => storage.delete(k),
    ...(storage.subscribe ? { subscribe: storage.subscribe.bind(storage) } : {}),
  };
  return {
    storage: coupled,
    saveLastEventId: (id) => { pending = id; },
    loadLastEventId: () => storage.get(lastEventIdKey),
    setFlushGate: (gate) => { flushGate = gate; },
  };
}

/** localStorage origins cap around 5–10 MB; leave plenty for everyone else. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

interface StoredDocument {
  version: number;
  writtenAt: number;
  entries: Array<[unknown, unknown, number]>;
}

function parseDocument(raw: string | null, version: number): StoredDocument | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredDocument;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.version !== version) return null;
    if (!Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sessionStoragePersister<K, V>(opts: {
  /** The environment's storage adapter — the seam, and the test seam. */
  storage: SessionStorage;
  /** Full storage key; callers scope it per KB (`semiont.cache.<kbId>.<name>`). */
  storageKey: string;
  /** Schema version; mismatch discards on load. Bump when the value shape changes. */
  version: number;
  /** Byte cap for the serialized document; oldest-written entries evicted first. */
  maxBytes?: number;
  /** Serialize a key to a JSON-safe value. Default identity (branded ids are strings). */
  keyToJson?: (k: K) => unknown;
  /** Deserialize a JSON value back to a key. Default identity. */
  jsonToKey?: (j: unknown) => K;
}): CachePersister<K, V> {
  const { storage, storageKey, version } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keyToJson = opts.keyToJson ?? ((k: K) => k as unknown);
  const jsonToKey = opts.jsonToKey ?? ((j: unknown) => j as K);

  /**
   * Prior write stamps, keyed by the serialized key. Seeded by load(),
   * refreshed by save() and external changes — an unchanged value keeps its
   * stamp so eviction order reflects real write recency.
   */
  let stamps = new Map<string, { valueJson: string; writtenAt: number }>();

  const seedStamps = (doc: StoredDocument): void => {
    stamps = new Map(
      doc.entries.map(([keyJson, value, writtenAt]) => [
        JSON.stringify(keyJson),
        { valueJson: JSON.stringify(value), writtenAt },
      ]),
    );
  };

  const toMap = (doc: StoredDocument): Map<K, V> =>
    new Map(doc.entries.map(([keyJson, value]) => [jsonToKey(keyJson), value as V]));

  return {
    load(): Map<K, V> | null {
      const doc = parseDocument(storage.get(storageKey), version);
      if (!doc) return null;
      seedStamps(doc);
      return toMap(doc);
    },

    save(entries: Map<K, V>): void {
      const now = Date.now();
      let records: Array<[unknown, unknown, number]> = [];
      const nextStamps = new Map<string, { valueJson: string; writtenAt: number }>();

      for (const [k, v] of entries) {
        const keyJson = keyToJson(k);
        const keyId = JSON.stringify(keyJson);
        const valueJson = JSON.stringify(v);
        const prior = stamps.get(keyId);
        const writtenAt = prior !== undefined && prior.valueJson === valueJson ? prior.writtenAt : now;
        nextStamps.set(keyId, { valueJson, writtenAt });
        records.push([keyJson, v, writtenAt]);
      }

      // Byte-cap eviction: drop oldest-written entries until the document
      // fits. Measured in real UTF-8 bytes (the option's name tells the
      // truth): `.length` counts UTF-16 code units, which skews up to 3×
      // for non-ASCII values. localStorage itself accounts in code units,
      // so for that substrate the byte cap is conservative — acceptable
      // for a guard rail.
      const encoder = new TextEncoder();
      const documentSize = (list: Array<[unknown, unknown, number]>): number =>
        encoder.encode(JSON.stringify({ version, writtenAt: now, entries: list })).length;
      if (documentSize(records) > maxBytes) {
        records = [...records].sort((a, b) => a[2] - b[2]);
        while (records.length > 0 && documentSize(records) > maxBytes) {
          const [evicted] = records.splice(0, 1);
          if (evicted) nextStamps.delete(JSON.stringify(evicted[0]));
        }
      }

      stamps = nextStamps;
      storage.set(storageKey, JSON.stringify({ version, writtenAt: now, entries: records }));
    },

    subscribe(onExternalChange: (entries: Map<K, V>) => void): () => void {
      const unsubscribe = storage.subscribe?.((key, newValue) => {
        if (key !== storageKey) return;
        const doc = parseDocument(newValue, version);
        if (!doc) return;
        seedStamps(doc);
        onExternalChange(toMap(doc));
      });
      return unsubscribe ?? (() => {});
    },
  };
}
