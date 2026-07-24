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

      // Byte-cap eviction: drop oldest-written entries until the document fits.
      const documentSize = (list: Array<[unknown, unknown, number]>): number =>
        JSON.stringify({ version, writtenAt: now, entries: list }).length;
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
