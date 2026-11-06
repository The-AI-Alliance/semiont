import { Observable, Subject, share } from 'rxjs';
import { Bus, FrameRefusal, JOB_SILENCE_MS, JOB_STATUS_POLL_MS, SemiontError } from '@semiont/core';
import type { EventBus, EventMap, ITransport, JobErrorCode, components } from '@semiont/core';

type JobStatusResponse = components['schemas']['JobStatusResponse'];
type FailureClass = components['schemas']['FailureClass'];

/**
 * A job its follower was following failed and will not be tried again: what
 * its worker reported on `job:fail`, or what its status states. A failure the
 * queue will retry is not this; the follower is told of it and keeps going.
 *
 * `failureClass` is the failure's class where it has one, so that a caller
 * tells "the provider would not answer" (`withheld`) from "the job broke"
 * (`deterministic`) without reading the message.
 */
export class JobFailedError extends SemiontError {
  declare code: JobErrorCode;

  constructor(
    message: string,
    public readonly jobId: string,
    public readonly failureClass: FailureClass | undefined,
  ) {
    super(message, 'job.failed' satisfies JobErrorCode, { jobId });
    this.name = 'JobFailedError';
  }
}

/**
 * A job its follower was following was cancelled. Nothing announces a
 * cancellation, so a follower learns of one from the job's status.
 */
export class JobCancelledError extends SemiontError {
  declare code: JobErrorCode;

  constructor(public readonly jobId: string) {
    super('The job was cancelled', 'job.cancelled' satisfies JobErrorCode, { jobId });
    this.name = 'JobCancelledError';
  }
}

/** `jobSilenceMs` and `jobStatusPollMs` of protocol/specs/src/client/timing.json, for a caller that must not wait them out. */
export interface JobFollowTiming {
  jobSilenceMs?: number;
  jobStatusPollMs?: number;
}

/**
 * How a job's follower learns what it was not sent. A job's progress and its
 * end reach the client as passing frames: a dropped stream loses them and
 * nothing redelivers them. So a follower that has heard nothing of
 * its job for `jobSilenceMs` asks for the job's status, and goes on asking
 * every `jobStatusPollMs` until the job says something or it is told to stop.
 * It asks one at a time: a poll that comes round while the last ask is
 * unanswered asks nothing. An ask that fails with a `SemiontError` is asked
 * again at the next poll; one that fails with anything else is given to
 * `onFailure`, which ends the follower.
 */
export class JobStatusPoll {
  private silence: ReturnType<typeof setTimeout> | null = null;
  private polling: ReturnType<typeof setInterval> | null = null;
  private asking = false;
  private readonly silenceMs: number;
  private readonly pollMs: number;

  private readonly wire: Bus;

  constructor(
    transport: ITransport,
    private readonly onStatus: (status: JobStatusResponse) => void,
    private readonly onFailure: (error: unknown) => void,
    timing: JobFollowTiming = {},
  ) {
    this.wire = new Bus(transport);
    this.silenceMs = timing.jobSilenceMs ?? JOB_SILENCE_MS;
    this.pollMs = timing.jobStatusPollMs ?? JOB_STATUS_POLL_MS;
  }

  /** The job said something, or was just created: the silence starts again. */
  heard(jobId: string): void {
    this.stop();
    this.silence = setTimeout(() => {
      this.ask(jobId);
      this.polling = setInterval(() => this.ask(jobId), this.pollMs);
    }, this.silenceMs);
  }

  stop(): void {
    if (this.silence) { clearTimeout(this.silence); this.silence = null; }
    if (this.polling) { clearInterval(this.polling); this.polling = null; }
  }

  private ask(jobId: string): void {
    if (this.asking) return;
    this.asking = true;
    this.wire.request('job:status-requested', { jobId }).then(
      (status) => {
        this.asking = false;
        this.onStatus(status);
      },
      (error: unknown) => {
        this.asking = false;
        // A status that cannot be had is asked for again at the next poll.
        if (!(error instanceof SemiontError)) this.onFailure(error);
      },
    );
  }
}

type JobFrameChannel = 'job:report-progress' | 'job:complete' | 'job:fail';

/**
 * One job's frames, picked out of every job's, and the frames refused on
 * their channels. A follower subscribes before it creates its job, and learns
 * the job's id only when the reply to `job:create` settles, which is a few
 * turns after the reply's frame was handled: a frame of the job read from the
 * stream alongside that reply is handled first. Frames that arrive before the
 * id is known are therefore held, and those of the job, and the refusals,
 * delivered in the order they came, once it is.
 */
export class JobFrames {
  private jobId: string | null = null;
  private held: Array<() => void> = [];
  private readonly refusals = new Subject<FrameRefusal>();
  private readonly channels: { readonly [K in JobFrameChannel]: Observable<EventMap[K]> };

  /** The frames refused, by their transport or as their channel's, on the job's channels while they are read: each names no job, so any may be this job's. */
  readonly refused$: Observable<FrameRefusal> = this.refusals.asObservable();

  constructor(private readonly bus: EventBus) {
    this.channels = {
      'job:report-progress': this.read('job:report-progress'),
      'job:complete': this.read('job:complete'),
      'job:fail': this.read('job:fail'),
    };
  }

  /** The job's frames on `channel`. */
  of<K extends JobFrameChannel>(channel: K): Observable<EventMap[K]> {
    return this.channels[channel];
  }

  /** `channel` read once, however many read it: each frame of the job is given, and each frame refused on it is told to `refused$`. */
  private read<K extends JobFrameChannel>(channel: K): Observable<EventMap[K]> {
    return new Observable<EventMap[K]>((subscriber) =>
      this.bus.on(channel).subscribe((frame) =>
        this.inTurn(() => {
          if (frame instanceof FrameRefusal) this.refusals.next(frame);
          else if (frame.jobId === this.jobId) subscriber.next(frame);
        }),
      ),
    ).pipe(share());
  }

  private inTurn(deliver: () => void): void {
    if (this.jobId === null) this.held.push(deliver);
    else deliver();
  }

  /** The job has its id: what was held is delivered, and frames pass as they come. */
  started(jobId: string): void {
    this.jobId = jobId;
    const held = this.held;
    this.held = [];
    for (const deliver of held) deliver();
  }
}

