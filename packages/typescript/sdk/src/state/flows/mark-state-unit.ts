import { BehaviorSubject, type Subscription } from 'rxjs';
import type { SemiontClient } from '../../client';
import { DELEGATE_SILENCE_MS, watched, type JobId, type MarkJobParams, type Motivation, type ResourceId, type Selector, type StateUnit, type Watched, type components } from '@semiont/core';
import { JobCancelledError } from '../../namespaces/job-status-poll';

type JobProgress = components['schemas']['JobProgress'];

export interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface MarkStateUnit extends StateUnit {
  pendingAnnotation$: Watched<PendingAnnotation | null>;
  delegatingMotivation$: Watched<Motivation | null>;
  progress$: Watched<JobProgress | null>;
  /**
   * The motivation of the run whose progress `progress$` holds: set when a
   * job is delegated, kept through its end so its display stays its
   * motivation's, and null once the progress is dismissed or cleared by a
   * failure. `delegatingMotivation$` says what is running; this says whose
   * display the progress is.
   */
  progressMotivation$: Watched<Motivation | null>;
  /**
   * Why the last delegated job ended without completing: it failed or was
   * cancelled. A `SemiontError`'s `code` says which. Null while a job is
   * under way, after one that completed, and once dismissed.
   */
  failure$: Watched<Error | null>;
  /**
   * The id of the delegated job, from the queue's answer to its creation to
   * the job's end: what `client.job.cancel` names. Null before the answer,
   * when there is no id, and after the end, when there is nothing to cancel.
   */
  jobId$: Watched<JobId | null>;
  /**
   * Delegate annotating this unit's resource as a `mark` job of `params`, and
   * follow it: its motivation, its progress, its id and how it ended. A job
   * delegated while another runs replaces it here.
   */
  requestDelegate(params: MarkJobParams): void;
  /** Drop the annotation being composed. */
  cancelPending(): void;
  /** Clear the last job's progress, what it was of and why it ended. */
  dismissProgress(): void;
}

export function createMarkStateUnit(
  client: SemiontClient,
  resourceId: ResourceId,
): MarkStateUnit {
  const subs: Subscription[] = [];
  const pendingAnnotation$ = new BehaviorSubject<PendingAnnotation | null>(null);
  const delegatingMotivation$ = new BehaviorSubject<Motivation | null>(null);
  const progress$ = new BehaviorSubject<JobProgress | null>(null);
  const progressMotivation$ = new BehaviorSubject<Motivation | null>(null);
  const failure$ = new BehaviorSubject<Error | null>(null);
  const jobId$ = new BehaviorSubject<JobId | null>(null);
  // A completed BehaviorSubject still takes a value from `next`, which its
  // `getValue` then gives: once disposed, nothing here may set one.
  let disposed = false;

  // A finished run STAYS on screen, and so does a cancelled one. There is no
  // dismissal timer: the result line — "Created 7 references" — is the one
  // thing in the whole run worth reading, and a timer that eats it makes the
  // run seem to vanish mid-sentence. The ended display carries an
  // explicit Close control; it clears on that (`dismissProgress`), or when the
  // next delegated job replaces it.

  // A request and a submission reach this unit as signals on the client's own
  // bus, which name their resource: N units on one client (multi-viewer hosts)
  // each act on their own. Everything else is asked of the unit itself.
  //
  // The view layer opens the annotations panel when `pendingAnnotation$`
  // becomes non-null: the unit updates state, and UI side effects belong to
  // the view, where the host's bus is.
  subs.push(client.bus.on('mark:requested').subscribe((event) => {
    if (event.source !== resourceId) return;
    pendingAnnotation$.next({ selector: event.selector as Selector | Selector[], motivation: event.motivation });
  }));

  subs.push(client.bus.on('mark:submit').subscribe(async (event) => {
    if (event.source !== resourceId) return;
    try {
      await client.mark.annotation({
        motivation: event.motivation,
        target: { source: resourceId, selector: event.selector as Selector },
        body: event.body,
      });
      if (disposed) return;
      // The composer closes HERE, not on `mark:create-ok`. The wire reply
      // carries no `resourceId` (MarkCreateOk is `{ response: { annotationId } }`),
      // so it could not be told apart: with two viewers on one session,
      // creating an annotation in either would discard the other's
      // in-progress selection. Clearing in the flow that owns the pending state
      // is correlated by construction. A host that wants to cancel a composer
      // calls `cancelPending`.
      pendingAnnotation$.next(null);
    } catch (error) {
      if (disposed) return;
      // Client-local, resource-stamped UI notification — the wire reply
      // (mark:create-failed) is Bus.request plumbing, not for UI consumption.
      client.bus.emit('mark:create-error', { resourceId, message: error instanceof Error ? error.message : String(error) });
    }
  }));

  // A delegated job. `mark.delegate` creates the job and follows it: it gives the
  // job's progress on `next`, completes on `job:complete`, errors on a
  // `job:fail` that is final. The unit drives its state from that stream.
  const requestDelegate = (params: MarkJobParams): void => {
    if (disposed) return;
    const { motivation } = params;
    delegatingMotivation$.next(motivation);
    progress$.next(null);
    progressMotivation$.next(motivation);
    failure$.next(null);
    jobId$.next(null);
    // This job's id. At the job's end it is forgotten only while it is still
    // the one held: a job delegated later replaces it.
    let created: JobId | null = null;
    const forgetJob = () => {
      if (created !== null && jobId$.getValue() === created) jobId$.next(null);
    };

    // Silence detector, NOT a timeout. The job
    // outlives the client's attention: a run the UI gives up on can go on
    // to persist its annotations (221, in one measured run). So going quiet
    // must degrade the display — never tear the subscription down, which
    // would leave the real completion with nothing to resolve, and never
    // claim the job ended while the worker is still working.
    //
    // Workers emit a heartbeat every ~15 s while a call is in flight, so
    // reaching this window means the worker really has gone quiet.
    // `mark:delegate-timeout` reports that silence; despite its name it ends
    // nothing.
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStale = () => {
      if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    };
    const armStale = () => {
      clearStale();
      staleTimer = setTimeout(() => {
        staleTimer = null;
        const last = progress$.getValue();
        // No prose here: the wire (and this state unit's output) carries
        // codes, not sentences, and the stale notice is the UI's copy to
        // own — it hears about the silence via `mark:delegate-timeout` below.
        progress$.next({
          ...(last ?? {}),
          percentage: last?.percentage ?? 0,
        });
        // The one notification the user gets. `delegatingMotivation$` stays
        // set: the job is still running as far as anyone here knows.
        client.bus.emit('mark:delegate-timeout', { resourceId, motivation });
      }, DELEGATE_SILENCE_MS);
    };
    armStale();

    const delegationSub = client.mark.delegate(resourceId, params).subscribe({
      next: (e) => {
        armStale();
        // Surface only the live progress events to the UI; the final
        // `complete` event carries `result` for callers awaiting the
        // delegation, but the panel just dismisses on `complete`. Terminal
        // outcomes (success / clean decline / failure) are surfaced as toasts
        // by useOutcomeToasts (react-ui), which subscribes job:complete /
        // job:fail directly — not through this Observable.
        if (e.kind === 'progress') progress$.next(e.data);
        if (e.kind === 'created') {
          created = e.data.jobId;
          jobId$.next(created);
        }
      },
      complete: () => {
        // Resolves the UI whenever it arrives — including long after the
        // silence marker, which is the whole point of not tearing down.
        // `delegatingMotivation$` going null is what flips the display to its
        // ended form; the payload is left in place for the user to read.
        clearStale();
        delegatingMotivation$.next(null);
        forgetJob();
      },
      error: (error: unknown) => {
        // Why it ended is said before the end itself, so no reader sees an
        // ended job that has no reason yet.
        clearStale();
        failure$.next(error instanceof Error ? error : new Error(String(error)));
        // A cancellation is announced by nothing else, and the job's commits
        // stand: its display stays, to say so. A real failure: `job:fail`
        // already toasts it through the outcome channel, so its display goes.
        if (!(error instanceof JobCancelledError)) {
          progress$.next(null);
          progressMotivation$.next(null);
        }
        delegatingMotivation$.next(null);
        forgetJob();
      },
    });
    // Disposing stops the silence detector with the job's subscription.
    delegationSub.add(clearStale);
    subs.push(delegationSub);
  };

  return {
    pendingAnnotation$: watched(pendingAnnotation$),
    delegatingMotivation$: watched(delegatingMotivation$),
    progress$: watched(progress$),
    progressMotivation$: watched(progressMotivation$),
    failure$: watched(failure$),
    jobId$: watched(jobId$),
    requestDelegate,
    cancelPending() {
      if (!disposed) pendingAnnotation$.next(null);
    },
    dismissProgress() {
      if (disposed) return;
      progress$.next(null);
      progressMotivation$.next(null);
      failure$.next(null);
    },
    dispose() {
      disposed = true;
      subs.forEach(s => s.unsubscribe());
      pendingAnnotation$.complete();
      delegatingMotivation$.complete();
      progress$.complete();
      progressMotivation$.complete();
      failure$.complete();
      jobId$.complete();
    },
  };
}
