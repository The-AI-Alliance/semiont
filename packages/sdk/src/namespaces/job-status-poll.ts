import { Observable } from 'rxjs';
import { busRequest, JOB_SILENCE_MS, JOB_STATUS_POLL_MS, SemiontError } from '@semiont/core';
import type { EventBus, EventMap, ITransport, JobErrorCode, components } from '@semiont/core';

type JobStatusResponse = components['schemas']['JobStatusResponse'];

/**
 * A job its follower was following failed and will not be tried again: what
 * its worker reported on `job:fail`, or what its status states. A failure the
 * queue will retry is not this; the follower is told of it and keeps going.
 */
export class JobFailedError extends SemiontError {
  declare code: JobErrorCode;

  constructor(message: string, public readonly jobId: string) {
    super(message, 'job.failed' satisfies JobErrorCode, { jobId });
    this.name = 'JobFailedError';
  }
}

/** `jobSilenceMs` and `jobStatusPollMs` of specs/src/client/timing.json, for a caller that must not wait them out. */
export interface JobFollowTiming {
  jobSilenceMs?: number;
  jobStatusPollMs?: number;
}

/**
 * How a job's follower learns what it was not sent. A job's progress and its
 * end reach the client as frames with no identity: a dropped stream loses
 * them and nothing redelivers them. So a follower that has heard nothing of
 * its job for `jobSilenceMs` asks for the job's status, and goes on asking
 * every `jobStatusPollMs` until the job says something or it is told to stop.
 */
export class JobStatusPoll {
  private silence: ReturnType<typeof setTimeout> | null = null;
  private polling: ReturnType<typeof setInterval> | null = null;
  private readonly silenceMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly transport: ITransport,
    private readonly onStatus: (status: JobStatusResponse) => void,
    timing: JobFollowTiming = {},
  ) {
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
    // A status that cannot be had is asked for again at the next poll.
    busRequest(this.transport, 'job:status-requested', { jobId }).then(this.onStatus, () => {});
  }
}

type JobFrameChannel = 'job:report-progress' | 'job:complete' | 'job:fail';

/**
 * One job's frames, picked out of every job's. A follower subscribes before
 * it creates its job, and learns the job's id only when the reply to
 * `job:create` settles, which is a few turns after the reply's frame was
 * handled: a frame of the job read from the stream alongside that reply is
 * handled first. Frames that arrive before the id is known are therefore
 * held, and those of the job delivered, in the order they came, once it is.
 */
export class JobFrames {
  private jobId: string | null = null;
  private held: Array<() => void> = [];

  constructor(private readonly bus: EventBus) {}

  of<K extends JobFrameChannel>(channel: K): Observable<EventMap[K]> {
    return new Observable<EventMap[K]>((subscriber) =>
      this.bus.on(channel).subscribe((frame) => {
        const deliver = (): void => {
          if (frame.jobId === this.jobId) subscriber.next(frame);
        };
        if (this.jobId === null) this.held.push(deliver);
        else deliver();
      }),
    );
  }

  /** The job has its id: what was held is delivered, and frames pass as they come. */
  started(jobId: string): void {
    this.jobId = jobId;
    const held = this.held;
    this.held = [];
    for (const deliver of held) deliver();
  }
}

