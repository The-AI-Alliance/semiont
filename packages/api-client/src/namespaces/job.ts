/**
 * JobNamespace — worker lifecycle
 */

import type { JobId, AccessToken, components } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { JobNamespace as IJobNamespace } from './types';

type JobStatusResponse = components['schemas']['JobStatusResponse'];
type TokenGetter = () => AccessToken | undefined;

export class JobNamespace implements IJobNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly getToken: TokenGetter,
  ) {}

  async status(jobId: JobId): Promise<JobStatusResponse> {
    return this.http.getJobStatus(jobId, { auth: this.getToken() });
  }

  async pollUntilComplete(
    jobId: JobId,
    options?: { interval?: number; timeout?: number; onProgress?: (status: JobStatusResponse) => void },
  ): Promise<JobStatusResponse> {
    return this.http.pollJobUntilComplete(jobId, {
      interval: options?.interval,
      timeout: options?.timeout,
      onProgress: options?.onProgress as Parameters<typeof this.http.pollJobUntilComplete>[1] extends { onProgress?: infer P } ? P : never,
      auth: this.getToken(),
    });
  }

  async cancel(jobId: JobId, type: string): Promise<void> {
    // Emit cancel request on the EventBus — the job worker picks it up
    throw new Error(`Not implemented: job.cancel(${jobId}, ${type}) — needs EventBus wiring`);
  }
}
