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
import { resourceId as toResourceId } from '@semiont/core';
import { CacheObservable, StreamObservable, UploadObservable } from '../awaitable';

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

describe('StreamObservable.run', () => {
  it('subscribes the producer exactly ONCE — progress via callback, terminal via the promise (A2 fix)', async () => {
    let subscribeCount = 0;
    const stream = new StreamObservable<string>((subscriber) => {
      subscribeCount += 1;
      subscriber.next('progress');
      subscriber.next('done');
      subscriber.complete();
    });
    const seen: string[] = [];
    const last = await stream.run((v) => seen.push(v));
    expect(subscribeCount).toBe(1);
    expect(seen).toEqual(['progress', 'done']);
    expect(last).toBe('done');
  });

  it('rejects when the source errors', async () => {
    const stream = new StreamObservable<number>((subscriber) => {
      subscriber.next(1);
      subscriber.error(new Error('boom'));
    });
    await expect(stream.run(() => {})).rejects.toThrow('boom');
  });

  it('rejects when the source completes without emitting (mirrors lastValueFrom)', async () => {
    const stream = new StreamObservable<number>((subscriber) => {
      subscriber.complete();
    });
    await expect(stream.run(() => {})).rejects.toThrow();
  });

  it('characterizes the A2 footgun: subscribe + await fires a COLD producer TWICE', async () => {
    // The trap `run()` exists to avoid. Pinned so the MULTICAST-JOB-TRIGGERS
    // redesign (which would make this 1) is a deliberate, tested flip — not a
    // silent behavior change.
    let subscribeCount = 0;
    const stream = new StreamObservable<number>((subscriber) => {
      subscribeCount += 1;
      subscriber.next(1);
      subscriber.complete();
    });
    stream.subscribe({ next: () => {} });
    await stream;
    expect(subscribeCount).toBe(2);
  });
});

describe('UploadObservable.run', () => {
  it('forwards each progress event and resolves { resourceId } from ONE subscription', async () => {
    let subscribeCount = 0;
    const upload = new UploadObservable((subscriber) => {
      subscribeCount += 1;
      subscriber.next({ phase: 'started', totalBytes: 10 });
      subscriber.next({ phase: 'progress', bytesUploaded: 5, totalBytes: 10 });
      subscriber.next({ phase: 'finished', resourceId: toResourceId('res-1') });
      subscriber.complete();
    });
    const phases: string[] = [];
    const result = await upload.run((e) => phases.push(e.phase));
    expect(subscribeCount).toBe(1);
    expect(phases).toEqual(['started', 'progress', 'finished']);
    expect(result).toEqual({ resourceId: toResourceId('res-1') });
  });

  it('rejects if the terminal event is not "finished"', async () => {
    const upload = new UploadObservable((subscriber) => {
      subscriber.next({ phase: 'started', totalBytes: 0 });
      subscriber.complete();
    });
    await expect(upload.run(() => {})).rejects.toThrow();
  });
});
