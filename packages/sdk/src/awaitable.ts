/**
 * The Observable subclasses namespace methods return.
 *
 * `StreamObservable` (gather, match), `DelegationObservable` (a delegated
 * job) and `UploadObservable` also implement `PromiseLike`, so a script can
 * `await` the call directly without a `lastValueFrom` wrapper; reactive
 * consumers keep using `.subscribe(...)` and `.pipe(...)`. `CacheObservable`
 * (Browse live queries) is deliberately NOT thenable: its one-shot read is
 * the explicit `.fresh()`.
 *
 * ⚠️ Pick ONE consumption per stream, delegation or upload instance. All
 * three are **cold** Observables, so `await` and `.subscribe(...)` each re-run
 * the producer — doing both on the same instance fires the underlying
 * request, job or upload *twice* (`.then` calls `lastValueFrom`, which
 * subscribes again). To get progress *and* the terminal result from a single
 * execution, use `.run(onNext)`.
 *
 * `.pipe(...)` returns a plain `Observable<T>` (RxJS doesn't propagate
 * subclasses through `pipe`). Once you compose, you've explicitly entered
 * RxJS land; `lastValueFrom` from `rxjs` is the right bridge there.
 */

import { Observable, EmptyError, firstValueFrom, lastValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ResourceId, components } from '@semiont/core';
import type { CacheState } from './cache';

/**
 * Bounded Observable stream — emits zero-or-more progress values, then a
 * final value on completion. Used by `gather.annotation`, `gather.resource`
 * and `match.search`.
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
   * failure — so a re-read reflects writes. `.subscribe(...)` never
   * uses it: it keeps the stale-while-revalidate cached view over `source`.
   */
  private fetchFresh?: () => Promise<T>;

  /**
   * Explicit one-shot read: a FRESH network fetch that updates the store
   * (subscribers see it too), resolves with the value, and REJECTS on
   * failure — the caller owns retry policy (B14 boundary 1). The class is
   * deliberately not `PromiseLike`: `await client.browse.x(...)` does not
   * compile, so a refactor that wraps a call site in `async` cannot
   * silently convert a cache read into a network round trip.
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
   * without a scoped subscription. `.subscribe(...)` consumers keep
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
 * `'finished'` event, so `await client.yield.resource(...)` callers don't
 * need to narrow the union.
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

/**
 * How a delegated job ended when it did its work: its `job:complete`. It is
 * its verb's: a `mark` job's carries its counts or a decline
 * (`MarkJobCompletion`), a `yield` job's the resource it made or a decline
 * (`YieldJobCompletion`).
 */
export type JobCompletion = components['schemas']['JobCompleteCommand'];
export type MarkJobCompletion = components['schemas']['MarkJobCompleteCommand'];
export type YieldJobCompletion = components['schemas']['YieldJobCompleteCommand'];

/**
 * One event of a delegated job. The first is `created`: the queue's answer
 * to the job's creation, whose `jobId` names the job to `job.cancel` and
 * `job.status`. `progress` events come while the worker runs, and the last
 * event is `complete`, carrying the job's completion.
 *
 * `failed` is a failure the queue will try again: the job is not over, a
 * fresh attempt follows, and the stream stays open. Render it as a setback,
 * not an ending. A failure that is final is not an event: it errors the
 * stream.
 */
export type JobEvent<C extends JobCompletion = JobCompletion> =
  | { kind: 'created'; data: components['schemas']['JobCreatedResult']['response'] }
  | { kind: 'progress'; data: components['schemas']['JobProgress'] }
  | { kind: 'failed'; data: components['schemas']['JobFailCommand'] }
  | { kind: 'complete'; data: C };

/** The completion a delegated job's last event carries. */
function completionOf<C extends JobCompletion>(last: JobEvent<C> | undefined): C {
  if (last?.kind !== 'complete') {
    throw new Error(`A delegated job ended on ${last ? `a ${last.kind} event` : 'no event'}, not on its completion`);
  }
  return last.data;
}

/**
 * A delegated job, from `mark.delegate` and `yield.delegate`. Subscribers see
 * the job's events as it goes (`JobEvent`), the queue's naming of it the
 * first of them and its completion the last. Awaiting resolves to the
 * completion itself, so `(await ...).result` is read without narrowing an
 * event, and is the result its verb reports.
 */
export class DelegationObservable<C extends JobCompletion = JobCompletion> extends Observable<JobEvent<C>> implements PromiseLike<C> {
  then<R1 = C, R2 = never>(
    onfulfilled?: ((v: C) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return lastValueFrom(this).then(completionOf).then(onfulfilled, onrejected);
  }

  /**
   * Subscribe **once**, delivering every `JobEvent` to `onNext`, and resolve
   * to the job's completion (rejects on error). The single-subscription way
   * to follow a job's progress *and* get how it ended — unlike
   * `.subscribe(...)` + `await`, which re-runs this cold Observable and
   * creates the job twice.
   */
  run(onNext: (event: JobEvent<C>) => void): Promise<C> {
    return new Promise<C>((resolve, reject) => {
      let last: JobEvent<C> | undefined;
      this.subscribe({
        next: (event) => {
          last = event;
          onNext(event);
        },
        error: reject,
        complete: () => {
          try {
            resolve(completionOf(last));
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }
}
