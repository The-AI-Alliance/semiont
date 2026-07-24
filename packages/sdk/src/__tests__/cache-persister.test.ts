/**
 * B17 (LOCAL-STORAGE W2) — the SessionStorage-backed persister adapter.
 *
 * Contract under test: round-trip through a storage adapter; version
 * mismatch and parse garbage read as "nothing stored" (never throw);
 * byte cap evicts oldest-written entries first; cross-context subscribe
 * delegates through the storage's own subscription seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sessionStoragePersister } from '../cache-persister';
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
