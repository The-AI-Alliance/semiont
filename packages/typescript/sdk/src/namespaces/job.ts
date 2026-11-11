import type { Observable } from 'rxjs';
import type { EventBus, EventMap, FrameRefusal, JobId, components } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { Bus, BUS_REQUEST_TIMEOUT_MS, BusRequestError, JOB_POLL_MS, JOB_POLL_TIMEOUT_MS } from '@semiont/core';
import { ClaimsObservable, type ClaimOptions } from '../claims';
import type { JobNamespace as IJobNamespace } from './types';

type JobStatusResponse = components['schemas']['JobStatusResponse'];

export class JobNamespace implements IJobNamespace {
  private readonly wire: Bus;

  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {
    this.wire = new Bus(transport);
  }

  /**
   * Live stream of `job:queued` events. Surfaces a typed view onto the
   * underlying bus channel for consumers (CLIs, MCP handlers, widgets)
   * that orchestrate jobs and need to react to lifecycle transitions. Each
   * stream here gives, in place of an event whose payload is not its
   * channel's, its `FrameRefusal`.
   */
  get queued$(): Observable<EventMap['job:queued'] | FrameRefusal> {
    return this.bus.on('job:queued');
  }

  /** Live stream of `job:report-progress` events. */
  get progress$(): Observable<EventMap['job:report-progress'] | FrameRefusal> {
    return this.bus.on('job:report-progress');
  }

  /** Live stream of `job:complete` events (global; filter by `jobId`). */
  get complete$(): Observable<EventMap['job:complete'] | FrameRefusal> {
    return this.bus.on('job:complete');
  }

  /** Live stream of `job:fail` events (global; filter by `jobId`). */
  get fail$(): Observable<EventMap['job:fail'] | FrameRefusal> {
    return this.bus.on('job:fail');
  }

  async status(jobId: JobId): Promise<JobStatusResponse> {
    return this.wire.request(
      'job:status-requested',
      { jobId },
    );
  }

  async pollUntilComplete(
    jobId: JobId,
    options?: { interval?: number; timeout?: number; onProgress?: (status: JobStatusResponse) => void },
  ): Promise<JobStatusResponse> {
    const interval = options?.interval ?? JOB_POLL_MS;
    const timeout = options?.timeout ?? JOB_POLL_TIMEOUT_MS;
    const due = Date.now() + timeout;
    const timedOut = () => new BusRequestError(`Job polling timed out after ${timeout}ms`, 'bus.timeout', { jobId });

    while (true) {
      const left = due - Date.now();
      if (left <= 0) throw timedOut();
      // The limit counts the asks too: one still unanswered at it fails there.
      const status = await this.wire.request('job:status-requested', { jobId }, Math.min(left, BUS_REQUEST_TIMEOUT_MS));
      if (options?.onProgress) options.onProgress(status);
      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }
      const waitLeft = due - Date.now();
      if (waitLeft <= 0) throw timedOut();
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, waitLeft)));
    }
  }

  /**
   * Cancel ONE job by id. Resolves with whether the queue acted on it: a
   * PENDING job is cancelled outright; a RUNNING one is left to its worker,
   * which stops its work and settles the job with `job:cancel`, so `true`
   * means "accepted", not "already stopped". `false` is
   * a job the queue does not know, or one already over. Rejects on a queue
   * failure.
   */
  async cancel(jobId: JobId): Promise<boolean> {
    const { cancelled } = await this.wire.request(
      'job:cancel-requested',
      { jobId },
    );
    return cancelled;
  }

  claim(options: ClaimOptions): ClaimsObservable {
    return new ClaimsObservable(this.transport, options);
  }
}
