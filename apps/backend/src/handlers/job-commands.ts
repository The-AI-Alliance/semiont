import { nanoid } from 'nanoid';
import { jobId, userId, resourceId, entityType } from '@semiont/core';
import type { EventBus } from '@semiont/core';
import type { JobQueue } from '@semiont/jobs';
import { getLogger } from '../logger';

const logger = () => getLogger().child({ component: 'job-commands' });

function parseDidUser(did: string): { userId: string; email: string; domain: string } {
  const parts = did.split(':');
  const usersIdx = parts.indexOf('users');
  const domain = parts.slice(2, usersIdx).join(':');
  const email = decodeURIComponent(parts.slice(usersIdx + 1).join(':'));
  return { userId: did, email, domain };
}

export function registerJobCommandHandlers(eventBus: EventBus, jobQueue: JobQueue): void {
  eventBus.get('job:create').subscribe(async (command) => {
    const { correlationId, jobType, resourceId: resId, params, _userId } = command as Record<string, unknown>;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }

      const user = parseDidUser(_userId);

      const job = {
        status: 'pending' as const,
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: jobType as string,
          userId: userId(_userId),
          userName: user.email,
          userEmail: user.email,
          userDomain: user.domain,
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: jobType === 'generation' ? 3 : 1,
        },
        params: {
          resourceId: resourceId(resId as string),
          ...(params as Record<string, unknown>),
        } as Record<string, unknown>,
      };

      const jobParams = job.params as Record<string, unknown>;
      if (jobType === 'reference-annotation' && jobParams.entityTypes) {
        jobParams.entityTypes = (jobParams.entityTypes as string[]).map(et => entityType(et));
      }

      await jobQueue.createJob(job as never);

      logger().info('Job created via bus', { jobId: job.metadata.id, jobType, correlationId });

      (eventBus.get('job:created') as { next(v: unknown): void }).next({
        correlationId,
        response: { jobId: job.metadata.id },
      });
    } catch (error) {
      logger().error('job:create failed', { correlationId, error: (error as Error).message });
      (eventBus.get('job:create-failed') as { next(v: unknown): void }).next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });

  eventBus.get('job:claim').subscribe(async (command) => {
    const { correlationId, jobId: jid } = command as Record<string, unknown>;

    try {
      const job = await jobQueue.getJob(jobId(jid as string)) as {
        metadata: Record<string, unknown>;
        status: string;
        params: unknown;
      } | null;

      if (!job) {
        throw new Error('Job not found');
      }
      if (job.status !== 'pending') {
        throw new Error('Job already claimed');
      }

      const runningJob = {
        ...job,
        status: 'running' as const,
        startedAt: new Date().toISOString(),
        progress: {},
      };

      await jobQueue.updateJob(runningJob as never, 'pending');

      (eventBus.get('job:claimed') as { next(v: unknown): void }).next({
        correlationId,
        response: runningJob,
      });
    } catch (error) {
      (eventBus.get('job:claim-failed') as { next(v: unknown): void }).next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });
}
