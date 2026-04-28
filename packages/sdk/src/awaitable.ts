/**
 * Thenable Observable subclasses.
 *
 * Two thin Observable subclasses that also implement `PromiseLike<T>`. Used as
 * the public return type of namespace methods that emit streams (job
 * lifecycle, generation progress) and cache reads (Browse live queries).
 *
 * The point: scripts can `await` the call directly without `lastValueFrom` /
 * `firstValueFrom` wrappers; reactive consumers keep using `.subscribe(...)`
 * and `.pipe(...)` exactly as before.
 *
 * The asymmetric `.then()` semantics — last-value-on-completion for streams,
 * first-non-undefined-value for caches — is encoded by the subclass name. The
 * docstring on the namespace method tells the consumer which one applies.
 *
 * `.pipe(...)` returns a plain `Observable<T>` (RxJS doesn't propagate
 * subclasses through `pipe`). Once you compose, you've explicitly entered
 * RxJS land; `lastValueFrom` from `rxjs` is the right bridge there.
 */

import { Observable, firstValueFrom, lastValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ResourceId } from '@semiont/core';

/**
 * Bounded Observable stream — emits zero-or-more progress values, then a
 * final value on completion. Used by job-lifecycle methods like
 * `mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`.
 *
 * Awaiting resolves to the **last** emitted value (via `lastValueFrom`).
 * Subscribing yields every emission, ending in `complete`.
 */
export class StreamObservable<T> extends Observable<T> implements PromiseLike<T> {
  then<R1 = T, R2 = never>(
    onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return lastValueFrom(this).then(onfulfilled, onrejected);
  }

  /** Wrap an existing Observable's subscribe behavior in a StreamObservable. */
  static from<T>(source: Observable<T>): StreamObservable<T> {
    return new StreamObservable<T>((subscriber) => source.subscribe(subscriber));
  }
}

/**
 * Multicast cache observable — emits `undefined` while the underlying value
 * is loading, then the value, then re-emits when bus events invalidate the
 * cache entry. Used by Browse live-query methods (`browse.resource`,
 * `browse.annotations`, etc.).
 *
 * Awaiting resolves to the **first non-undefined** value (waits past the
 * loading state). Subscribing yields the full sequence including the
 * initial `undefined`, so reactive consumers can render a loading state.
 *
 * The class is parameterized as `CacheObservable<T>` even though the
 * stream's element type is `T | undefined` — `T` is what the consumer
 * gets from `await`, and that's the contract we want to advertise. The
 * `Observable<T | undefined>` shape leaks through `.subscribe` and
 * `.pipe` in the natural way.
 */
export class CacheObservable<T> extends Observable<T | undefined> implements PromiseLike<T> {
  then<R1 = T, R2 = never>(
    onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return firstValueFrom(this.pipe(filter((v): v is T => v !== undefined)))
      .then(onfulfilled, onrejected);
  }

  /**
   * Wrap an existing Observable's subscribe behavior in a `CacheObservable`.
   *
   * Memoizes on source identity: passing the same `source` returns the same
   * wrapper instance. The Browse cache primitive already returns a stable
   * Observable per key (its B4 contract), so this preserves that contract
   * through the awaitable wrapping. Without the memo, every public-method
   * call would produce a fresh wrapper and break referential-equality
   * guarantees that hook-style reactive consumers depend on.
   *
   * Backed by a `WeakMap`, so wrappers are GC'd when their source is.
   */
  static from<T>(source: Observable<T | undefined>): CacheObservable<T> {
    let wrapper = wrapperCache.get(source) as CacheObservable<T> | undefined;
    if (!wrapper) {
      wrapper = new CacheObservable<T>((subscriber) => source.subscribe(subscriber));
      wrapperCache.set(source, wrapper);
    }
    return wrapper;
  }
}

const wrapperCache = new WeakMap<Observable<unknown>, CacheObservable<unknown>>();

/**
 * Discriminated phases of an upload's lifecycle.
 *
 * - `started` — emitted immediately on `yield.resource(...)` invocation, before any bytes flow.
 * - `progress` — emitted as bytes flow. Not yet wired by `HttpContentTransport` (would require an XHR/`Request({ duplex })` rewrite to expose granular byte counts); reserved for that mechanism. `bytesUploaded` and `totalBytes` carry the numbers when emitted.
 * - `finished` — emitted on backend acknowledgement, carries the assigned `resourceId`.
 *
 * Failures surface as `Observable.error(...)` (typically an `APIError` from the transport's `errors$` Subject), not as a `phase: 'failed'` event — `subscribe`'s error callback handles them.
 */
export type UploadProgress =
  | { phase: 'started'; totalBytes: number }
  | { phase: 'progress'; bytesUploaded: number; totalBytes: number }
  | { phase: 'finished'; resourceId: ResourceId };

/**
 * Specialized `StreamObservable` for `yield.resource`. Subscribers see the
 * full `UploadProgress` event sequence (started → optional progress → finished).
 * Awaiting resolves specifically to `{ resourceId }` extracted from the
 * `'finished'` event — preserving the pre-Phase-18 awaited shape so existing
 * `await client.yield.resource(...)` callers don't need to narrow the union.
 */
export class UploadObservable extends Observable<UploadProgress> implements PromiseLike<{ resourceId: ResourceId }> {
  then<R1 = { resourceId: ResourceId }, R2 = never>(
    onfulfilled?: ((v: { resourceId: ResourceId }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return lastValueFrom(this).then((v) => {
      if (v.phase !== 'finished') {
        throw new Error(`UploadObservable resolved on a non-finished event: ${v.phase}`);
      }
      const result = { resourceId: v.resourceId };
      return onfulfilled ? onfulfilled(result) : (result as unknown as R1);
    }, onrejected);
  }
}
