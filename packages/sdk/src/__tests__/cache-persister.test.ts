/**
 * B17 (LOCAL-STORAGE W2) — the SessionStorage-backed persister adapter.
 *
 * Contract under test: round-trip through a storage adapter; version
 * mismatch and parse garbage read as "nothing stored" (never throw);
 * byte cap evicts oldest-written entries first; cross-context subscribe
 * delegates through the storage's own subscription seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coupledLastEventId, sessionStoragePersister } from '../cache-persister';
import type { SessionStorage } from '../session/session-storage';
import { TestStorage } from '../session/__tests__/test-storage-helpers';

const KEY = 'semiont.cache.kb-1.resource';

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
    const writer = sessionStoragePersister<string, { name: string }>({ storage, storageKey: KEY, version: 1 });
    writer.save(new Map([['r1', { name: 'One' }], ['r2', { name: 'Two' }]]));

    const reader = sessionStoragePersister<string, { name: string }>({ storage, storageKey: KEY, version: 1 });
    const loaded = reader.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.get('r1')).toEqual({ name: 'One' });
    expect(loaded!.get('r2')).toEqual({ name: 'Two' });
  });

  it('reads as empty on version mismatch', () => {
    sessionStoragePersister<string, string>({ storage, storageKey: KEY, version: 1 })
      .save(new Map([['r1', 'v']]));

    const v2 = sessionStoragePersister<string, string>({ storage, storageKey: KEY, version: 2 });
    expect(v2.load()).toBeNull();
  });

  it('reads as empty on parse garbage — never throws', () => {
    storage.set(KEY, '{not json');
    const persister = sessionStoragePersister<string, string>({ storage, storageKey: KEY, version: 1 });
    expect(persister.load()).toBeNull();
  });

  it('evicts oldest-written entries first when over the byte cap', () => {
    const persister = sessionStoragePersister<string, string>({
      storage,
      storageKey: KEY,
      version: 1,
      // Small enough that three entries with 100-char values cannot all fit.
      maxBytes: 300,
    });

    persister.save(new Map([['old', 'x'.repeat(100)]]));
    vi.setSystemTime(2_000_000);
    persister.save(new Map([['old', 'x'.repeat(100)], ['mid', 'y'.repeat(100)]]));
    vi.setSystemTime(3_000_000);
    persister.save(new Map([['old', 'x'.repeat(100)], ['mid', 'y'.repeat(100)], ['new', 'z'.repeat(100)]]));

    const loaded = sessionStoragePersister<string, string>({ storage, storageKey: KEY, version: 1 }).load();
    expect(loaded).not.toBeNull();
    // 'old' carries the earliest write stamp — evicted first.
    expect(loaded!.has('old')).toBe(false);
    expect(loaded!.has('new')).toBe(true);
  });

  it('measures the byte cap in bytes, not UTF-16 code units', () => {
    // '€' is 1 code unit but 3 UTF-8 bytes: 60 units ≈ 180 bytes per value.
    // A cap that passes on code-unit length must still evict on real bytes.
    const persister = sessionStoragePersister<string, string>({
      storage,
      storageKey: KEY,
      version: 1,
      maxBytes: 400,
    });

    persister.save(new Map([['old', '€'.repeat(60)]]));
    vi.setSystemTime(2_000_000);
    persister.save(new Map([['old', '€'.repeat(60)], ['new', '€'.repeat(60)]]));

    const loaded = sessionStoragePersister<string, string>({ storage, storageKey: KEY, version: 1 }).load();
    expect(loaded).not.toBeNull();
    expect(loaded!.has('old')).toBe(false);
    expect(loaded!.has('new')).toBe(true);
  });

  it('delegates cross-context sync through storage.subscribe', () => {
    const persister = sessionStoragePersister<string, string>({ storage, storageKey: KEY, version: 1 });
    const onExternalChange = vi.fn();
    persister.subscribe!(onExternalChange);

    // Another context writes the same key.
    const other = sessionStoragePersister<string, string>({ storage, storageKey: KEY, version: 1 });
    other.save(new Map([['r1', 'from-elsewhere']]));
    storage.dispatch(KEY, storage.get(KEY));

    expect(onExternalChange).toHaveBeenCalledTimes(1);
    const received = onExternalChange.mock.calls[0]![0] as Map<string, string>;
    expect(received.get('r1')).toBe('from-elsewhere');

    // Unrelated keys and version-mismatched payloads are ignored.
    storage.dispatch('some.other.key', '{}');
    storage.dispatch(KEY, JSON.stringify({ version: 99, writtenAt: 1, entries: [] }));
    expect(onExternalChange).toHaveBeenCalledTimes(1);
  });

  it('supports key transformers for non-string keys', () => {
    const opts = {
      storage,
      storageKey: KEY,
      version: 1,
      keyToJson: (k: number) => String(k),
      jsonToKey: (j: unknown) => Number(j),
    };
    sessionStoragePersister<number, string>(opts).save(new Map([[42, 'answer']]));

    const loaded = sessionStoragePersister<number, string>(opts).load();
    expect(loaded!.get(42)).toBe('answer');
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
    };
    return { storage, writes, inner };
  }

  it('saveLastEventId alone writes nothing — the id must never lead the caches', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId('p-res-1-47');

    expect(writes).toHaveLength(0);
    expect(storage.get(ID_KEY)).toBeNull();
  });

  it('a cache-document write flushes the pending id — document first, id second', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId('p-res-1-47');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');

    expect(writes.map(([k]) => k)).toEqual(['semiont.cache.kb-1.resource', ID_KEY]);
    expect(storage.get(ID_KEY)).toBe('p-res-1-47');
  });

  it('with no pending id, a document write is just a document write', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');

    expect(writes.map(([k]) => k)).toEqual(['semiont.cache.kb-1.resource']);
  });

  it('multiple events before one flush persist the latest id exactly once', () => {
    const { storage, writes } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);

    coupled.saveLastEventId('p-res-1-47');
    coupled.saveLastEventId('p-res-1-48');
    coupled.storage.set('semiont.cache.kb-1.annotations', '{"doc":2}');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":3}');

    expect(storage.get(ID_KEY)).toBe('p-res-1-48');
    expect(writes.filter(([k]) => k === ID_KEY)).toHaveLength(1);
  });

  it('loadLastEventId round-trips what a flush persisted', () => {
    const { storage } = recordingStorage();
    const coupled = coupledLastEventId(storage, ID_KEY);
    coupled.saveLastEventId('p-res-1-47');
    coupled.storage.set('semiont.cache.kb-1.resource', '{"doc":1}');

    expect(coupledLastEventId(storage, ID_KEY).loadLastEventId()).toBe('p-res-1-47');
  });
});
