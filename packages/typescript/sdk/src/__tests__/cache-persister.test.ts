/**
 * B17 — the SessionStorage-backed persister adapter.
 *
 * Contract under test: round-trip through a storage adapter; parse garbage
 * reads as "nothing stored" (never throws); byte cap evicts the oldest-stamped
 * entries first. What a load keeps of each kept query's document, and of the
 * stream's places, is protocol/specs/src/session/cache-cases.json's, run by
 * cache-cases.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coupledLastEventId, sessionStoragePersister, type EntryDecoder } from '../cache-persister';
import type { SessionStorage } from '../session/session-storage';
import { personKey } from '../session/storage';
import { TestStorage } from '../session/__tests__/test-storage-helpers';
import { createTestClient, inMemoryContent } from '../testing';
import { isObject, isString, resourceId, type components } from '@semiont/core';

type GetAnnotationsResponse = components['schemas']['GetAnnotationsResponse'];

const KEY = 'semiont.cache.kb-1.resource';

/** Entries of any text key and text value. */
const TEXT: EntryDecoder<string, string> = { key: isString, value: isString };

/** Entries of any text key and a named value. */
const NAMED: EntryDecoder<string, { name: string }> = {
  key: isString,
  value: (json): json is { name: string } => isObject(json) && isString(json['name']),
};

describe('sessionStoragePersister (B17)', () => {
  let storage: TestStorage;

  beforeEach(() => {
    storage = new TestStorage();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a map through the storage adapter', () => {
    const writer = sessionStoragePersister({ storage, storageKey: KEY, decode: NAMED });
    writer.save(new Map([['r1', { name: 'One' }], ['r2', { name: 'Two' }]]));

    const reader = sessionStoragePersister({ storage, storageKey: KEY, decode: NAMED });
    const loaded = reader.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.get('r1')).toEqual({ name: 'One' });
    expect(loaded!.get('r2')).toEqual({ name: 'Two' });
  });

  it('reads as empty on parse garbage — never throws', () => {
    storage.set(KEY, '{not json');
    const persister = sessionStoragePersister({ storage, storageKey: KEY, decode: TEXT });
    expect(persister.load()).toBeNull();
  });

  it('evicts the oldest-stamped entries first when over the byte cap', () => {
    const persister = sessionStoragePersister({
      storage,
      storageKey: KEY,
      decode: TEXT,
      // Small enough that three entries with 100-char values cannot all fit.
      maxBytes: 300,
    });

    persister.save(new Map([['old', 'x'.repeat(100)]]));
    vi.setSystemTime(2_000_000);
    persister.save(new Map([['old', 'x'.repeat(100)], ['mid', 'y'.repeat(100)]]));
    vi.setSystemTime(3_000_000);
    persister.save(new Map([['old', 'x'.repeat(100)], ['mid', 'y'.repeat(100)], ['new', 'z'.repeat(100)]]));

    const loaded = sessionStoragePersister({ storage, storageKey: KEY, decode: TEXT }).load();
    expect(loaded).not.toBeNull();
    // 'old' carries the earliest stamp — evicted first.
    expect(loaded!.has('old')).toBe(false);
    expect(loaded!.has('new')).toBe(true);
  });

  it('measures the byte cap in bytes, not UTF-16 code units', () => {
    // '€' is 1 code unit but 3 UTF-8 bytes: 60 units ≈ 180 bytes per value.
    // A cap that passes on code-unit length must still evict on real bytes.
    const persister = sessionStoragePersister({
      storage,
      storageKey: KEY,
      decode: TEXT,
      maxBytes: 400,
    });

    persister.save(new Map([['old', '€'.repeat(60)]]));
    vi.setSystemTime(2_000_000);
    persister.save(new Map([['old', '€'.repeat(60)], ['new', '€'.repeat(60)]]));

    const loaded = sessionStoragePersister({ storage, storageKey: KEY, decode: TEXT }).load();
    expect(loaded).not.toBeNull();
    expect(loaded!.has('old')).toBe(false);
    expect(loaded!.has('new')).toBe(true);
  });
});

describe('coupledLastEventId (B17 — the bookmark rides the cache flush)', () => {
  const ID_KEY = 'semiont.lastEventId.kb-1';

  function recordingStorage() {
    const writes: Array<[string, string]> = [];
    const inner = new TestStorage();
    const storage: SessionStorage = {
      get: (k) => inner.get(k),
      set: (k, v) => { writes.push([k, v]); inner.set(k, v); },
      delete: (k) => inner.delete(k),
      update: (k, change) => inner.update(k, (stored) => {
        const next = change(stored);
        if (next !== null) writes.push([k, next]);
        return next;
      }),
      subscribe: (handler) => inner.subscribe(handler),
    };
    return { storage, writes, inner };
  }

  it('saveLastEventId alone writes nothing — the ids must never lead the caches', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-47');

    expect(writes).toHaveLength(0);
    expect(storage.get(ID_KEY)).toBeNull();
  });

  it('a cache-document write flushes the pending ids — document first, ids second', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-47');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');

    expect(writes.map(([k]) => k)).toEqual(['semiont.cache.kb-1.resource', ID_KEY]);
    expect(JSON.parse(storage.get(ID_KEY)!)).toEqual({ 'res-1': 'p-res-1-47' });
  });

  it('a cache-document update flushes the pending ids as a set does, once the client the places are coupled to is at rest', async () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);
    const refusals: Array<(reason: Error) => void> = [];
    const { client } = createTestClient({
      content: {
        ...inMemoryContent(),
        getAnnotations: () => new Promise<GetAnnotationsResponse>((_, reject) => { refusals.push(reject); }),
      },
      cachePersistence: { storage: coupled.storage, kbId: 'kb-1', personKey: personKey('did:web:example.org:users:jo') },
    });
    coupled.coupleTo(client);
    // A kept cache's fetch is in flight: the client is not at rest.
    const asked = client.browse.annotations(resourceId('res-1')).fresh();

    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-47');
    coupled.storage.update('semiont.cache.kb-1.resource', () => '{"doc":1}');

    // The caches are not quiet: the ids stay pending, lagging.
    expect(writes.map(([k]) => k)).toEqual(['semiont.cache.kb-1.resource']);
    expect(storage.get(ID_KEY)).toBeNull();

    // The fetch fails, and nothing is in flight or owed: the client is at rest, having written nothing.
    refusals.forEach((refuse) => refuse(new Error('the gateway refused the read')));
    await expect(asked).rejects.toThrow('the gateway refused the read');
    coupled.storage.update('semiont.cache.kb-1.resource', () => '{"doc":2}');

    // Document first, ids second.
    expect(writes.map(([k]) => k)).toEqual(['semiont.cache.kb-1.resource', 'semiont.cache.kb-1.resource', ID_KEY]);
    expect(JSON.parse(storage.get(ID_KEY)!)).toEqual({ 'res-1': 'p-res-1-47' });
    client.dispose();
  });

  it('with no pending ids, a document write is just a document write', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');

    expect(writes.map(([k]) => k)).toEqual(['semiont.cache.kb-1.resource']);
  });

  it('multiple events before one flush persist the latest id per scope exactly once', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-47');
    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-48');
    coupled.saveLastEventId(resourceId('res-2'), 'p-res-2-5');
    coupled.storage.set('semiont.cache.kb-1.annotations', '{"doc":2}');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":3}');

    expect(JSON.parse(storage.get(ID_KEY)!)).toEqual({ 'res-1': 'p-res-1-48', 'res-2': 'p-res-2-5' });
    expect(writes.filter(([k]) => k === ID_KEY)).toHaveLength(1);
  });

  it('a later flush MERGES onto stored watermarks — other scopes survive', () => {
    const { storage } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-47');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');
    coupled.saveLastEventId(resourceId('res-2'), 'p-res-2-9');
    coupled.storage.set('semiont.cache.kb-1.annotations', '{"doc":2}');

    expect(JSON.parse(storage.get(ID_KEY)!)).toEqual({ 'res-1': 'p-res-1-47', 'res-2': 'p-res-2-9' });
  });

  it('loadLastEventIds round-trips what a flush persisted', () => {
    const { storage } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);
    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-47');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');

    expect(coupledLastEventId(storage, ID_KEY).loadLastEventIds()).toEqual(new Map([['res-1', 'p-res-1-47']]));
  });

  it('a stored place under a key that is not a resource id is not loaded', () => {
    // Storage is text a browser kept: nothing typed it. A place under a key
    // the rule refuses could only be sent as a `scope` the gateway refuses,
    // so it is left behind and the places beside it are kept.
    const { storage } = recordingStorage();
    storage.set(ID_KEY, JSON.stringify({ 'not an id': 'p-x-1', 'a/b': 'p-y-2', 'res-1': 'p-res-1-47', 'res-2': 7 }));

    expect(coupledLastEventId(storage, ID_KEY).loadLastEventIds()).toEqual(new Map([['res-1', 'p-res-1-47']]));
  });

  it('an id that is no persisted event\'s id is never kept as a place', () => {
    const { storage } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId(resourceId('res-1'), 'e-res-1-47');
    coupled.saveLastEventId(resourceId('res-2'), 'p-res-2-9');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');

    expect(JSON.parse(storage.get(ID_KEY)!)).toEqual({ 'res-2': 'p-res-2-9' });
  });
});
