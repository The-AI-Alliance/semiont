/**
 * The Observable subclasses namespace methods return.
 *
 * `StreamObservable` (job lifecycle, generation progress) and
 * `UploadObservable` also implement `PromiseLike`, so a script can `await`
 * the call directly without a `lastValueFrom` wrapper; reactive consumers
 * keep using `.subscribe(...)` and `.pipe(...)`. `CacheObservable` (Browse
 * live queries) is deliberately NOT thenable: its one-shot read is the
 * explicit `.fresh()`.
 *
 * ⚠️ Pick ONE consumption per stream or upload instance. Both are **cold**
 * Observables, so `await` and `.subscribe(...)` each re-run the producer —
 * doing both on the same `StreamObservable`/`UploadObservable` fires the
 * underlying job/upload *twice* (`.then` calls `lastValueFrom`, which
 * subscribes again). To get progress *and* the terminal result from a single
 * execution, use `.run(onNext)`.
 *
 * `.pipe(...)` returns a plain `Observable<T>` (RxJS doesn't propagate
 * subclasses through `pipe`). Once you compose, you've explicitly entered
 * RxJS land; `lastValueFrom` from `rxjs` is the right bridge there.
 */

import { Observable, EmptyError, firstValueFrom, lastValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ResourceId } from '@semiont/core';
import type { CacheState } from './cache';

/**
 * Bounded Observable stream — emits zero-or-more progress values, then a
 * final value on completion. Used by job-lifecycle methods like
 * `mark.assist`, `gather.annotation`, `match.search`, `yield.fromContext`.
 *
 * Awaiting resolves to the **last** emitted value (via `lastValueFrom`).
 * Subscribing yields every emission, ending in `complete`. **Do not do both on
 * one instance** (see the module note); use `run()` for progress + result.
 */
export class StreamObservable<T> extends Observable<T> implements PromiseLike<T> {
  then<R1 = T, R2 = never>(
    onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return lastValueFrom(this).then(onfulfilled, onrejected);
  }

  /**
   * Subscribe **once**, delivering every emission to `onNext`, and resolve to
   * the last emitted value on completion (rejects on error, or with rxjs
   * `EmptyError` if the stream completes without emitting). The
   * single-subscription way to consume progress *and* the terminal result from
   * a job-triggering stream — unlike `.subscribe(...)` + `await`, which re-runs
   * this cold Observable and fires the underlying job twice.
   */
  run(onNext: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let last!: T;
      let hasValue = false;
      this.subscribe({
        next: (v) => {
          hasValue = true;
          last = v;
          onNext(v);
        },
        error: reject,
        complete: () => {
          if (hasValue) resolve(last);
          else reject(new EmptyError());
        },
      });
    });
  }

  /** Wrap an existing Observable's subscribe behavior in a StreamObservable. */
  static from<T>(source: Observable<T>): StreamObservable<T> {
    return new StreamObservable<T>((subscriber) => source.subscribe(subscriber));
  }
}

/**
 * Multicast cache observable — emits the `CacheState` at a key: `pending`
 * while the value loads, then `ready` with the value or `failed` with the
 * error, re-emitting when bus events invalidate the cache entry. Used by
 * Browse live-query methods (`browse.resource`, `browse.annotations`, etc.).
 *
 * Subscribing is the stale-while-revalidate live view. The class is not
 * thenable: the one-shot read is `.fresh()`.
 *
 * `T` is the value type — what a `ready` state carries and what `.fresh()`
 * resolves to. The stream's element type is `CacheState<T>`.
 */
export class CacheObservable<T> extends Observable<CacheState<T>> {
  /**
   * Optional one-shot fresh-fetch action backing `.fresh()`. When present,
   * `fresh()` resolves to a freshly fetched value and rejects on fetch
   * failure — so a re-read reflects writes (#847). `.subscribe(...)` never
   * uses it: it keeps the stale-while-revalidate cached view over `source`.
   */
  private fetchFresh?: () => Promise<T>;

  /**
   * Explicit one-shot read (settled 2026-07-29): a FRESH
   * network fetch that updates the store (subscribers see it too), resolves
   * with the value, and REJECTS on failure — the caller owns retry policy
   * (B14 boundary 1). This replaces the deleted `PromiseLike` surface:
   * `await client.browse.x(...)` no longer compiles, so a refactor that
   * wraps a call site in `async` can never again silently convert a cache
   * read into a network round trip.
   */
  fresh(): Promise<T> {
    if (this.fetchFresh) {
      return this.fetchFresh();
    }
    // Non-cache wrapper: settle on the first SETTLED state — ready resolves,
    // failed rejects (a pending-only stream keeps waiting; L2's budget lives
    // in the underlying request machinery, not here).
    return firstValueFrom(
      this.pipe(
        filter(
          (s): s is Exclude<CacheState<T>, { status: 'pending' }> => s.status !== 'pending',
        ),
      ),
    ).then((s) => {
      if (s.status === 'failed') throw s.error;
      return s.value;
    });
  }

  /**
   * Wrap an existing Observable's subscribe behavior in a `CacheObservable`.
   *
   * `fetchFresh`, when supplied, backs `.fresh()`: it resolves to a freshly
   * fetched value (rejecting on failure), so a one-shot read reflects writes
   * without a scoped subscription (#847). `.subscribe(...)` consumers keep
   * the SWR view over `source`.
   *
   * Memoizes on source identity: passing the same `source` returns the same
   * wrapper instance. The Browse cache primitive already returns a stable
   * Observable per key (its B4 contract), so this preserves that contract
   * through the wrapping. Without the memo, every public-method
   * call would produce a fresh wrapper and break referential-equality
   * guarantees that hook-style reactive consumers depend on.
   *
   * Backed by a `WeakMap`, so wrappers are GC'd when their source is.
   */
  static from<T>(source: Observable<CacheState<T>>, fetchFresh?: () => Promise<T>): CacheObservable<T> {
    let wrapper = wrapperCache.get(source) as CacheObservable<T> | undefined;
    if (!wrapper) {
      wrapper = new CacheObservable<T>((subscriber) => source.subscribe(subscriber));
      wrapper.fetchFresh = fetchFresh;
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
 * - `progress` — emitted as the bytes are sent over HTTP, in a browser and outside one; a transport with no wire to send them over emits none. `bytesUploaded` and `totalBytes` carry the running counts; `totalBytes` may be 0 when a browser can't determine the total (rare, e.g. chunked encoding) — UI consumers should render an indeterminate state in that case.
 * - `finished` — emitted on gateway acknowledgement, carries the assigned `resourceId`.
 *
 * Failures surface as `Observable.error(...)` (typically an `APIError` from the transport's `errors$` Subject), not as a `phase: 'failed'` event — `subscribe`'s error callback handles them. Cancellation is honored: unsubscribing before `finished` cancels the upload, and over HTTP closes its connection.
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

  /**
   * Subscribe **once**, delivering every `UploadProgress` event to `onNext`, and
   * resolve to `{ resourceId }` from the `finished` event (rejects on error, or
   * if the terminal event isn't `finished`). The single-subscription way to
   * track upload progress *and* get the resource id — unlike `.subscribe(...)` +
   * `await`, which re-runs this cold Observable and uploads twice.
   */
  run(onNext: (event: UploadProgress) => void): Promise<{ resourceId: ResourceId }> {
    return new Promise<{ resourceId: ResourceId }>((resolve, reject) => {
      let last: UploadProgress | undefined;
      this.subscribe({
        next: (e) => {
          last = e;
          onNext(e);
        },
        error: reject,
        complete: () => {
          if (last?.phase === 'finished') resolve({ resourceId: last.resourceId });
          else reject(new Error(`UploadObservable completed on a non-finished event: ${last?.phase ?? '<none>'}`));
        },
      });
    });
  }
}
