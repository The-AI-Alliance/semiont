import type { JobId, components } from '@semiont/core';
import type { ActorVM } from '../view-models/domain/actor-vm';
import { busRequest } from '../bus-request';
import type { JobNamespace as IJobNamespace } from './types';

type JobStatusResponse = components['schemas']['JobStatusResponse'];

export class JobNamespace implements IJobNamespace {
  constructor(
    private readonly actor: ActorVM,
  ) {}

  async status(jobId: JobId): Promise<JobStatusResponse> {
    return busRequest<JobStatusResponse>(
      this.actor,
      'job:status-requested',
      { jobId },
      'job:status-result',
      'job:status-failed',
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
        throw new Error(`Job polling timeout after ${timeout}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  async cancel(jobId: JobId, type: string): Promise<void> {
    await this.actor.emit('job:cancel-requested', { jobId, type });
  }
}
