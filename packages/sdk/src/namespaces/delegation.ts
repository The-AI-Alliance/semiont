import { merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type { EventBus, EventMap, ITransport, ResourceId, TransportErrorCode, components } from '@semiont/core';
import { busRequest, SemiontError } from '@semiont/core';
import { DelegationObservable, type JobCompletion } from '../awaitable';
import { GenerationStallError } from './generation-stall';
import { JobCancelledError, JobFailedError, JobFrames, JobStatusPoll, type JobFollowTiming } from './job-status-poll';

/**
 * How a follower reads its job's completion as its verb's. A completion is
 * heard as a `job:complete` frame, or learned from the job's status when the
 * stream did not carry the frame. The status does not say which verb its
 * result is, so each verb reads its own, and answers nothing for another's.
 */
export interface DelegatedVerb<C extends JobCompletion> {
  /** What `mark` or `yield` this is, for an error's words. */
  readonly jobType: C['jobType'];
  /** A `job:complete` frame as this verb's, or nothing when it is another's. */
  heard(frame: JobCompletion): C | undefined;
  /** The completion a complete job's status stands for, or nothing when its type or its result is another verb's. */
  learned(status: components['schemas']['JobStatusResponse'], resourceId: ResourceId): C | undefined;
}

/**
 * Creates a job and follows it to its end: the one driver behind
 * `mark.delegate` and `yield.delegate`.
 *
 * It sends `job:create` with the description given, gives the queue's answer
 * as the `created` event, then gives the job's `job:report-progress` /
 * `job:complete` / `job:fail` frames as `JobEvent`s, the status poll standing
 * in for a frame the stream did not carry.
 *
 * The three frames reach the client on the always-on global bridge: the
 * worker emits them to every client. Nothing here joins the resource's scope
 * (`transport.subscribeToResource`): a resource's scope carries none of the
 * three, and when nothing else holds that scope, joining and leaving it each
 * change the SSE channel set, which the HTTP transport applies by handing the
 * stream over to a second connection.
 *
 * `resourceId` is the resource the job is about, for the completion the
 * status poll stands in for (`JobStatusResponse` names none). It is not sent.
 *
 * `verb` reads the job's completion as its verb's. One that is another
 * verb's is not the job that was delegated. It is not a failed job either,
 * so the stream errors under the transport's code for a failure no other
 * names (`error`), as every SDK's follower does.
 *
 * `stallMs`, when given, is the ONE stall guard: armed at subscribe, armed
 * again on every event, cleared by any ending. It lives in this producer so
 * `await`, `.run()` and a state unit's drive all share it. Firing asks for
 * THAT job to be cancelled, by its id: a cancellation by type would end every
 * pending job of the type, whoever asked for it. A pending job is cancelled
 * outright; a running one is left to its worker. A job whose creation was
 * never answered has no id, and there is nothing to cancel. Then the stream
 * errors with `GenerationStallError`.
 */
export function delegated<C extends JobCompletion>(
  transport: ITransport,
  bus: EventBus,
  timing: JobFollowTiming,
  job: EventMap['job:create'],
  verb: DelegatedVerb<C>,
  resourceId: ResourceId,
  stallMs?: number,
): DelegationObservable<C> {
  return new DelegationObservable<C>((subscriber) => {
    let done = false;
    // The end: the job's completion, read as the verb's.
    const completed = (completion: C | undefined, from: string) => {
      if (completion === undefined) {
        subscriber.error(new SemiontError(`${from} is not a completed ${verb.jobType} job's`, 'error' satisfies TransportErrorCode));
        return;
      }
      subscriber.next({ kind: 'complete', data: completion });
      subscriber.complete();
    };
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = new JobStatusPoll(
      transport,
      (status) => {
        if (done) return;
        if (status.status === 'complete') {
          cleanup();
          // The `complete` event the stream did not carry, from the status.
          completed(verb.learned(status, resourceId), `The status of job ${status.jobId}`);
        } else if (status.status === 'failed') {
          cleanup();
          subscriber.error(new JobFailedError(status.error ?? 'Job failed', status.jobId));
        } else if (status.status === 'cancelled') {
          cleanup();
          subscriber.error(new JobCancelledError(status.jobId));
        }
      },
      timing,
    );

    const cleanup = () => {
      done = true;
      poll.stop();
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };

    // Subscribe to the job lifecycle before the job exists: `JobFrames` holds
    // what arrives until the job's id is known, and delivers only this job's.
    let activeJobId: string | null = null;
    const frames = new JobFrames(bus);
    const progress$ = frames.of('job:report-progress');
    const complete$ = frames.of('job:complete');
    const fail$ = frames.of('job:fail');

    // Only a failure the queue will not try again is an end. `takeUntil(fail$)`
    // would silence progress on a retryable failure too, so a run that
    // recovers would go quiet while the stream itself survives.
    const terminalFail$ = fail$.pipe(filter((e) => e.willRetry !== true));

    const armStall = () => {
      if (stallMs === undefined) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (done) return;
        const stalledJobId = activeJobId;
        cleanup();
        if (stalledJobId !== null) {
          void busRequest(transport, 'job:cancel-requested', { jobId: stalledJobId }).catch(() => {});
        }
        // subscriber.error runs the producer teardown, which unsubscribes
        // the three lifecycle subs — no manual unsubscribe needed here.
        subscriber.error(new GenerationStallError(stallMs, stalledJobId));
      }, stallMs);
    };

    const progressSub = progress$
      .pipe(takeUntil(merge(complete$, terminalFail$)))
      .subscribe((e) => {
        if (e.progress) subscriber.next({ kind: 'progress', data: e.progress });
        if (activeJobId) poll.heard(activeJobId);
        armStall();
      });

    const completeSub = complete$.subscribe((e) => {
      cleanup();
      completed(verb.heard(e), `A job:complete of job ${e.jobId}`);
    });

    const failSub = fail$.subscribe((e) => {
      // A retryable failure is an EVENT: the queue re-queues the job and a
      // fresh worker continues it, so ending the stream here would report a
      // recovering run as a failed one. `willRetry` is the worker's report of
      // what the queue will do, from the queue's own predicate. Absent reads
      // as final — the safe direction: a stream that ends early is visible,
      // one that never ends is not.
      if (e.willRetry === true) {
        subscriber.next({ kind: 'failed', data: e });
        // The attempt that died is not asked about: the next attempt's first
        // frame starts the poll again. The setback was heard, so the stall
        // deadline starts again too: one left running would cancel the
        // attempt that is coming.
        poll.stop();
        armStall();
        return;
      }
      cleanup();
      subscriber.error(new JobFailedError(e.error, e.jobId));
    });

    armStall();

    busRequest(transport, 'job:create', job)
      .then((created) => {
        const { jobId } = created;
        if (jobId && !done) {
          activeJobId = jobId;
          // Before the frames held for it are let go: the job's id is the
          // first thing its follower says.
          subscriber.next({ kind: 'created', data: created });
          poll.heard(jobId);
          frames.started(jobId);
        }
      })
      .catch((error) => {
        // If the stream has already ended (job:complete arrived before the
        // creation was answered, or the consumer disposed the client
        // mid-flight), there is no live subscriber to receive the error, and
        // RxJS would host it as an uncaught exception.
        if (done) return;
        cleanup();
        subscriber.error(error);
      });

    return () => {
      cleanup();
      progressSub.unsubscribe();
      completeSub.unsubscribe();
      failSub.unsubscribe();
    };
  });
}
