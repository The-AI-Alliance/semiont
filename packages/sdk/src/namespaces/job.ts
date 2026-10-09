import type { Observable } from 'rxjs';
import type { EventBus, EventMap, JobId, components } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { busRequest, BusRequestError } from '@semiont/core';
import { ClaimsObservable, type ClaimOptions } from '../claims';
import type { JobNamespace as IJobNamespace } from './types';

type JobStatusResponse = components['schemas']['JobStatusResponse'];

export class JobNamespace implements IJobNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  /**
   * Live stream of `job:queued` events. Surfaces a typed view onto the
   * underlying bus channel for consumers (CLIs, MCP handlers, widgets)
   * that orchestrate jobs and need to react to lifecycle transitions.
   */
  get queued$(): Observable<EventMap['job:queued']> {
    return this.bus.on('job:queued');
  }

  /** Live stream of `job:report-progress` events. */
  get progress$(): Observable<EventMap['job:report-progress']> {
    return this.bus.on('job:report-progress');
  }

  /** Live stream of `job:complete` events (global; filter by `jobId`). */
  get complete$(): Observable<EventMap['job:complete']> {
    return this.bus.on('job:complete');
  }

  /** Live stream of `job:fail` events (global; filter by `jobId`). */
  get fail$(): Observable<EventMap['job:fail']> {
    return this.bus.on('job:fail');
  }

  async status(jobId: JobId): Promise<JobStatusResponse> {
    return busRequest(
      this.transport,
      'job:status-requested',
      { jobId },
    );
  }

  async pollUntilComplete(
    jobId: JobId,
    options?: { interval?: number; timeout?: number; onProgress?: (status: JobStatusResponse) => void },
  ): Promise<JobStatusResponse> {
    const interval = options?.interval ?? 1000;
    const timeout = options?.timeout ?? 60000;
    const startTime = Date.now();

    while (true) {
      const status = await this.status(jobId);
      if (options?.onProgress) options.onProgress(status);
      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }
      if (Date.now() - startTime > timeout) {
        throw new BusRequestError(`Job polling timeout after ${timeout}ms`, 'bus.timeout', { jobId });
      }
      await new Promise(resolve => setTimeout(resolve, interval));
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
    const { cancelled } = await busRequest(
      this.transport,
      'job:cancel-requested',
      { jobId },
    );
    return cancelled;
  }

  claim(options: ClaimOptions): ClaimsObservable {
    return new ClaimsObservable(this.transport, options);
  }
}
