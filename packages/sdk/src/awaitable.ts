/**
 * Thenable Observable subclasses.
 *
 * Two thin Observable subclasses that also implement `PromiseLike<T>`. Used as
 * the public return type of namespace methods that emit streams (job
 * lifecycle, generation progress) and cache reads (Browse live queries).
 *
 * The point: scripts can `await` the call directly without `lastValueFrom` /
 * `firstValueFrom` wrappers; reactive consumers (frontend view-models) keep
 * using `.subscribe(...)` and `.pipe(...)` exactly as before.
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
   * guarantees that React-side consumers depend on.
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
