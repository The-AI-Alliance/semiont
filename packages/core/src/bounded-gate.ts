/**
 * boundedGate — cap concurrent async work across every caller of one gate.
 *
 * The gate is an object, not a wrapper around a call, and that is the whole
 * point: a limiter placed inside one operation bounds that operation, so N
 * concurrent callers get N × the "cap". Build one per resource being protected —
 * an embedding provider, say — and share it.
 *
 * ## Two limits, both deliberate
 *
 * **"Bounded" means in-flight, not queue depth.** The queue is unlimited, so the
 * gate queues rather than refuses. Cheap here — a queued job is a closure — but
 * it applies no upstream backpressure and must not be read as if it did.
 *
 * **Queued work is not cancellable.** There is no `AbortSignal`: a job whose
 * caller has already given up still runs when it acquires. That matters wherever
 * a deadline is threaded down to a retry, because a job can sit in the queue past
 * that deadline and then execute anyway. Adding cancellation means deciding what
 * a caller's abort does to work already running, which is a different question
 * from how many may run.
 *
 * ## Fairness
 *
 * Acquisition is FIFO. Nothing here depends on ordering — the point is that a
 * queued job cannot be indefinitely overtaken while work keeps arriving.
 *
 * ## When to use this vs `serializePerKey`
 *
 * `serializePerKey` bounds work *per key* to one at a time and lets different
 * keys overlap freely. This bounds *total* in-flight work regardless of key. Use
 * it when the constraint belongs to the thing being called (one local model
 * process, an API's rate limit), not to the identity of what is being worked on.
 */

import { Subject, defer, EMPTY } from 'rxjs';
import { catchError, mergeMap, tap } from 'rxjs/operators';

interface Job<T = unknown> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function boundedGate(concurrency: number): <T>(work: () => Promise<T>) => Promise<T> {
  // One Subject for the gate's lifetime. A per-call pipeline would cap per call,
  // which is the arithmetic this exists to fix.
  const jobs$ = new Subject<Job<never>>();

  jobs$
    .pipe(
      mergeMap(
        (job) =>
          // The laziness that makes the cap real is the THUNK in this gate's
          // signature: `work` is invoked here, and `mergeMap` reaches this
          // projection only when a slot is free. Accept a promise instead of a
          // thunk and every job starts at enqueue time, capping nothing while
          // appearing to work — measured: that swap fails three of the four
          // tests. `defer` is expressive rather than load-bearing (mergeMap
          // already defers the projection), and is kept so the intent survives a
          // reader who does not know that.
          defer(job.run).pipe(
            tap((value) => job.resolve(value)),
            // The rejection belongs to its caller, never to this subscription —
            // an error reaching the outer pipe kills the gate for everyone who
            // arrives later, silently and permanently.
            catchError((error) => { job.reject(error); return EMPTY; }),
          ),
        concurrency,
      ),
    )
    .subscribe();

  return <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      jobs$.next({ run: work, resolve, reject } as unknown as Job<never>);
    });
}
