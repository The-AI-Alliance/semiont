/**
 * Tests for the thenable Observable subclasses (`StreamObservable<T>`,
 * `CacheObservable<T>`).
 *
 * The contract:
 *   - `StreamObservable.then` resolves to the LAST emitted value on completion
 *     (mirrors `lastValueFrom`); errors reject the await.
 *   - `CacheObservable.then` resolves to the FIRST non-undefined emission
 *     (skips loading state); errors reject the await.
 *   - `.subscribe(...)` continues to deliver every emission as a plain
 *     Observable would.
 *   - `.pipe(...)` returns a plain `Observable<T>` — thenability is by design
 *     not preserved through composition (consumers reaching for pipe are in
 *     RxJS land).
 */

import { describe, expect, it } from 'vitest';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { CacheObservable, StreamObservable } from '../awaitable';

describe('StreamObservable', () => {
  it('await resolves to the last emitted value', async () => {
    const stream = new StreamObservable<number>((subscriber) => {
      subscriber.next(1);
      subscriber.next(2);
      subscriber.next(3);
      subscriber.complete();
    });
    const result = await stream;
    expect(result).toBe(3);
  });

  it('await rejects when the source errors', async () => {
    const stream = new StreamObservable<number>((subscriber) => {
      subscriber.next(1);
      subscriber.error(new Error('boom'));
    });
    await expect(stream).rejects.toThrow('boom');
  });

  it('subscribe yields every emission, ending in complete', async () => {
    const seen: number[] = [];
    let completed = false;
    const stream = new StreamObservable<number>((subscriber) => {
      subscriber.next(1);
      subscriber.next(2);
      subscriber.next(3);
      subscriber.complete();
    });
    await new Promise<void>((resolve) => {
      stream.subscribe({
        next: (v) => seen.push(v),
        complete: () => {
          completed = true;
          resolve();
        },
      });
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(completed).toBe(true);
  });

  it('pipe returns a plain Observable (no longer thenable)', () => {
    const stream = new StreamObservable<number>((subscriber) => {
      subscriber.next(1);
      subscriber.complete();
    });
    const piped = stream.pipe(map((v) => v * 2));
    expect(piped).toBeInstanceOf(Observable);
    expect(piped).not.toBeInstanceOf(StreamObservable);
    // The plain Observable doesn't have a `then` method.
    expect((piped as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('StreamObservable.from wraps an existing Observable', async () => {
    const source = new Observable<string>((subscriber) => {
      subscriber.next('a');
      subscriber.next('b');
      subscriber.complete();
    });
    const wrapped = StreamObservable.from(source);
    expect(wrapped).toBeInstanceOf(StreamObservable);
    expect(await wrapped).toBe('b');
  });
});

describe('CacheObservable', () => {
  it('await skips initial undefined and resolves to the first defined value', async () => {
    const cache = new CacheObservable<string>((subscriber) => {
      subscriber.next(undefined);
      subscriber.next(undefined);
      subscriber.next('loaded');
    });
    const result = await cache;
    expect(result).toBe('loaded');
  });

  it('await resolves immediately when the value is already present', async () => {
    const cache = new CacheObservable<number>((subscriber) => {
      subscriber.next(42);
    });
    expect(await cache).toBe(42);
  });

  it('await rejects when the source errors before producing a value', async () => {
    const cache = new CacheObservable<string>((subscriber) => {
      subscriber.error(new Error('fetch failed'));
    });
    await expect(cache).rejects.toThrow('fetch failed');
  });

  it('subscribe yields every emission including the loading undefined', async () => {
    const seen: Array<string | undefined> = [];
    const cache = new CacheObservable<string>((subscriber) => {
      subscriber.next(undefined);
      subscriber.next('value');
      subscriber.complete();
    });
    await new Promise<void>((resolve) => {
      cache.subscribe({
        next: (v) => seen.push(v),
        complete: () => resolve(),
      });
    });
    expect(seen).toEqual([undefined, 'value']);
  });

  it('pipe returns a plain Observable (no longer thenable)', () => {
    const cache = new CacheObservable<number>((subscriber) => {
      subscriber.next(1);
    });
    const piped = cache.pipe(map((v) => v ?? 0));
    expect(piped).toBeInstanceOf(Observable);
    expect(piped).not.toBeInstanceOf(CacheObservable);
    expect((piped as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('CacheObservable.from wraps an existing Observable<T | undefined>', async () => {
    const source = new Observable<string | undefined>((subscriber) => {
      subscriber.next(undefined);
      subscriber.next('hello');
    });
    const wrapped = CacheObservable.from(source);
    expect(wrapped).toBeInstanceOf(CacheObservable);
    expect(await wrapped).toBe('hello');
  });
});
