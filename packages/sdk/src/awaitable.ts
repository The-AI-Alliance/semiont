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
 * ⚠️ Pick ONE consumption per instance. These are **cold** Observables, so
 * `await` and `.subscribe(...)` each re-run the producer — doing both on the
 * same `StreamObservable`/`UploadObservable` fires the underlying job/upload
 * *twice* (`.then` calls `lastValueFrom`, which subscribes again). To get
 * progress *and* the terminal result from a single execution, use `.run(onNext)`.
 * A hot/multicast redesign that removes the footgun is proposed in
 * `.plans/MULTICAST-JOB-TRIGGERS.md`.
 *
 * The asymmetric `.then()` semantics — last-value-on-completion for streams,
 * first-non-undefined-value for caches — is encoded by the subclass name. The
 * docstring on the namespace method tells the consumer which one applies.
 *
 * `.pipe(...)` returns a plain `Observable<T>` (RxJS doesn't propagate
 * subclasses through `pipe`). Once you compose, you've explicitly entered
 * RxJS land; `lastValueFrom` from `rxjs` is the right bridge there.
 */

import { Observable, EmptyError, firstValueFrom, lastValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ResourceId } from '@semiont/core';

/**
 * Bounded Observable stream — emits zero-or-more progress values, then a
 * final value on completion. Used by job-lifecycle methods like
 * `mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`.
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
 * Multicast cache observable — emits `undefined` while the underlying value
 * is loading, then the value, then re-emits when bus events invalidate the
 * cache entry. Used by Browse live-query methods (`browse.resource`,
 * `browse.annotations`, etc.).
 *
 * Awaiting (the one-shot path) fetches a **fresh** value via the optional
 * `fetchFresh` action and rejects on failure — a re-read reflects writes
 * (#847). Subscribing yields the SWR sequence: the initial `undefined`, the
 * loaded value, and re-emits on invalidation. (Without a `fetchFresh` action
 * — e.g. a non-cache wrapper — the await falls back to the first
 * non-undefined emission.)
 *
 * The class is parameterized as `CacheObservable<T>` even though the
 * stream's element type is `T | undefined` — `T` is what the consumer
 * gets from `await`, and that's the contract we want to advertise. The
 * `Observable<T | undefined>` shape leaks through `.subscribe` and
 * `.pipe` in the natural way.
 */
export class CacheObservable<T> extends Observable<T | undefined> implements PromiseLike<T> {
  /**
   * Optional one-shot fresh-fetch action. When present, `then()` (the await
   * path) resolves to a freshly fetched value and rejects on fetch failure —
   * so a re-read reflects writes (#847). `.subscribe(...)` never uses it: it
   * keeps the stale-while-revalidate cached view over `source`.
   */
  private fetchFresh?: () => Promise<T>;

  then<R1 = T, R2 = never>(
    onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    if (this.fetchFresh) {
      // One-shot read: fetch fresh (rejects on failure), don't serve the memo.
      return this.fetchFresh().then(onfulfilled, onrejected);
    }
    // Non-cache wrapper: resolve to the first non-undefined emission.
    return firstValueFrom(this.pipe(filter((v): v is T => v !== undefined)))
      .then(onfulfilled, onrejected);
  }

  /**
   * Wrap an existing Observable's subscribe behavior in a `CacheObservable`.
   *
   * `fetchFresh`, when supplied, backs the await path: `await` resolves to a
   * freshly fetched value (rejecting on failure), so a one-shot read reflects
   * writes without a scoped subscription (#847). `.subscribe(...)` consumers
   * keep the SWR view over `source`.
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
  static from<T>(source: Observable<T | undefined>, fetchFresh?: () => Promise<T>): CacheObservable<T> {
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
 * - `progress` — emitted as bytes flow over the wire. Wired by `HttpContentTransport`'s XHR path when a caller passes `onProgress` (or, transitively, when `yield.resource` is the caller — it always wires the hook so subscribers see byte counts). `bytesUploaded` and `totalBytes` carry the running counts; `totalBytes` may be 0 when the transport can't determine the total (rare, e.g. chunked encoding) — UI consumers should render an indeterminate state in that case.
 * - `finished` — emitted on backend acknowledgement, carries the assigned `resourceId`.
 *
 * Failures surface as `Observable.error(...)` (typically an `APIError` from the transport's `errors$` Subject), not as a `phase: 'failed'` event — `subscribe`'s error callback handles them. Cancellation is honored: unsubscribing before `finished` aborts the in-flight HTTP request on the XHR path.
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
