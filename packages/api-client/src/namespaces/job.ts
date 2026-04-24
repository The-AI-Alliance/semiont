import type { EventBus, JobId, components } from '@semiont/core';
import type { ITransport } from '../transport/types';
import { busRequest } from '../bus-request';
import type { JobNamespace as IJobNamespace } from './types';

type JobStatusResponse = components['schemas']['JobStatusResponse'];

export class JobNamespace implements IJobNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  async status(jobId: JobId): Promise<JobStatusResponse> {
    return busRequest<JobStatusResponse>(
      this.transport,
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

  async cancel(_jobId: JobId, type: string): Promise<void> {
    // Schema only carries jobType (cancels all pending jobs of that type).
    // The legacy per-job cancel was never wired on the backend.
    await this.transport.emit('job:cancel-requested', {
      jobType: (type === 'generation' ? 'generation' : 'annotation') as 'annotation' | 'generation',
    });
  }

  cancelRequest(jobType: 'annotation' | 'generation'): void {
    // Local emit: the batch-cancel widget fires this; a VM subscribes and
    // translates into individual cancels.
    this.bus.get('job:cancel-requested').next({ jobType });
  }
}
