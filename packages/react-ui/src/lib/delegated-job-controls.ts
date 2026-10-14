import type { JobId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

/**
 * What a delegated job's progress display does when its one control is
 * pressed: cancel while the job runs, dismiss once it has ended.
 *
 * Its private fields make the type nominal. An object literal is not one, so
 * `DelegateShell`, which takes nothing else, cannot be composed with
 * callbacks written in place: only {@link delegatedJobControls}, which is
 * given the job's id, makes one.
 */
class Controls {
  readonly #jobId: JobId | null;
  readonly #onCancel: (() => Promise<boolean>) | undefined;
  readonly #onDismiss: (() => void) | undefined;

  constructor(jobId: JobId | null, onCancel: (() => Promise<boolean>) | undefined, onDismiss: (() => void) | undefined) {
    this.#jobId = jobId;
    this.#onCancel = onCancel;
    this.#onDismiss = onDismiss;
  }

  /** The job the display follows; `null` until the queue has named it. */
  get jobId(): JobId | null {
    return this.#jobId;
  }

  /** Resolves with whether the queue acted on the cancel; rejects when the request was refused. */
  get onCancel(): (() => Promise<boolean>) | undefined {
    return this.#onCancel;
  }

  get onDismiss(): (() => void) | undefined {
    return this.#onDismiss;
  }
}

export type DelegatedJobControls = Controls;

/**
 * The controls of the display that follows the job `jobId`. With no id yet,
 * because the queue has not answered the job's creation, or with no session
 * to send it on, there is no cancel and the display shows no control while
 * the job runs.
 *
 * @emits job:cancel-requested - Cancel the delegated job, by its id: pending, it is cancelled; running, the worker that holds it stops its work and settles it as cancelled. Payload: { jobId: JobId }
 */
export function delegatedJobControls(
  session: SemiontSession | null,
  jobId: JobId | null,
  onDismiss: (() => void) | undefined,
): DelegatedJobControls {
  const onCancel = session && jobId
    ? () => session.client.job.cancel(jobId).catch((error: unknown) => {
        console.error(`Failed to cancel job ${jobId}:`, error);
        throw error;
      })
    : undefined;
  return new Controls(jobId, onCancel, onDismiss);
}

/**
 * The controls of a `mark` job's display: its dismiss clears the mark
 * flow's progress.
 *
 * @emits mark:progress-dismiss - Dismiss the annotation progress display. Payload: undefined
 */
export function markJobControls(session: SemiontSession | null, jobId: JobId | null): DelegatedJobControls {
  return delegatedJobControls(session, jobId, () => session?.client.mark.dismissProgress());
}
