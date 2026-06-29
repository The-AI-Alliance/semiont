import { generateUuid, jobId, userId, resourceId, entityType } from '@semiont/core';
import type { EventBus, Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import type { JobQueue } from '@semiont/jobs';
import { readTagSchemasProjection } from '../views/tag-schemas-reader.js';
import { readEntityTypesProjection } from '../views/entity-types-reader.js';
import {
  resolveTagSchema,
  validateEntityTypes,
  entityTypesNotRegisteredMessage,
} from '../views/projection-validators.js';

function parseDidUser(did: string): { userId: string; email: string; domain: string } {
  const parts = did.split(':');
  const usersIdx = parts.indexOf('users');
  const domain = parts.slice(2, usersIdx).join(':');
  const email = decodeURIComponent(parts.slice(usersIdx + 1).join(':'));
  return { userId: did, email, domain };
}

export function registerJobCommandHandlers(
  eventBus: EventBus,
  jobQueue: JobQueue,
  project: SemiontProject,
  parentLogger: Logger,
): void {
  const logger = parentLogger.child({ component: 'job-commands' });

  eventBus.get('job:create').subscribe(async (command) => {
    const { correlationId, jobType, resourceId: resId, params, _userId } = command;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }

      const user = parseDidUser(_userId);

      const job = {
        status: 'pending' as const,
        metadata: {
          id: jobId(`job-${generateUuid()}`),
          type: jobType as string,
          userId: userId(_userId),
          userName: user.email,
          userEmail: user.email,
          userDomain: user.domain,
          created: new Date().toISOString(),
          retryCount: 0,
          // Generation is non-idempotent — a retry re-runs the LLM and produces
          // *different* content (not a replay) — and expensive. Surface the failure
          // to the caller rather than silently re-rolling. Detection jobs re-scan the
          // same content (≈idempotent) and keep one self-heal retry.
          maxRetries: jobType === 'generation' ? 0 : 1,
        },
        params: {
          resourceId: resourceId(resId as string),
          ...(params as Record<string, unknown>),
        } as Record<string, unknown>,
      };

      const jobParams = job.params as Record<string, unknown>;

      // Validate caller-supplied entity types against the per-KB
      // entity-type projection. Unknown tags reject synchronously
      // rather than letting the worker stamp a resource (or annotation
      // body) with a tag that isn't part of the KB's declared
      // vocabulary. Applies to every jobType that surfaces
      // `entityTypes` in `params`:
      //  - `reference-annotation` (mark.assist linking)
      //  - `generation` (yield.fromAnnotation)
      // The validator returns `{ ok: true }` for the no-tags-supplied
      // case, so the projection read only happens when there's
      // something to validate.
      if (
        (jobType === 'reference-annotation' || jobType === 'generation') &&
        Array.isArray(jobParams.entityTypes) &&
        jobParams.entityTypes.length > 0
      ) {
        const registered = await readEntityTypesProjection(project);
        const result = validateEntityTypes(registered, jobParams.entityTypes as string[]);
        if (!result.ok) {
          throw new Error(entityTypesNotRegisteredMessage(result.unknown));
        }
      }

      if (jobType === 'reference-annotation' && jobParams.entityTypes) {
        jobParams.entityTypes = (jobParams.entityTypes as string[]).map(et => entityType(et));
      }

      // Tag-annotation jobs: resolve the caller-supplied `schemaId` against
      // the per-KB tag-schema projection and embed the resolved schema in
      // the worker's params. Keeps the worker independent of the registry.
      if (jobType === 'tag-annotation') {
        const schemas = await readTagSchemasProjection(project);
        const result = resolveTagSchema(schemas, jobParams.schemaId);
        if (result.error !== undefined) {
          throw new Error(result.error);
        }
        jobParams.schema = result.schema;
        delete jobParams.schemaId;
      }

      await jobQueue.createJob(job as never);

      logger.info('Job created via bus', { jobId: job.metadata.id, jobType, correlationId });

      eventBus.get('job:created').next({
        correlationId,
        response: { jobId: job.metadata.id },
      });
    } catch (error) {
      logger.error('job:create failed', { correlationId, error: (error as Error).message });
      eventBus.get('job:create-failed').next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });

  eventBus.get('job:claim').subscribe(async (command) => {
    const { correlationId, jobId: jid } = command;

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

      eventBus.get('job:claimed').next({
        correlationId,
        response: runningJob,
      });
    } catch (error) {
      eventBus.get('job:claim-failed').next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });

  // ── Queue lifecycle sync ────────────────────────────────────────────
  // Stower persists job:complete / job:fail to the event log; these
  // subscriptions keep the *queue files* in step so `getStats()`,
  // `job:status-requested`, and retry bookkeeping reflect reality.

  eventBus.get('job:complete').subscribe(async (event) => {
    try {
      const moved = await jobQueue.completeJob(
        jobId(event.jobId),
        (event.result ?? {}) as Record<string, unknown>,
      );
      if (!moved) {
        logger.warn('job:complete for a job not in running', { jobId: event.jobId });
      }
    } catch (error) {
      logger.error('Failed to sync job completion to queue', {
        jobId: event.jobId,
        error: (error as Error).message,
      });
    }
  });

  eventBus.get('job:fail').subscribe(async (event) => {
    try {
      const outcome = await jobQueue.failJob(jobId(event.jobId), event.error);
      if (outcome === 'retried') {
        logger.info('Job re-queued for retry', { jobId: event.jobId });
      } else if (outcome === null) {
        logger.warn('job:fail for a job not in running', { jobId: event.jobId });
      }
    } catch (error) {
      logger.error('Failed to sync job failure to queue', {
        jobId: event.jobId,
        error: (error as Error).message,
      });
    }
  });

  eventBus.get('job:report-progress').subscribe(async (event) => {
    try {
      await jobQueue.recordProgress(
        jobId(event.jobId),
        (event.progress ?? { percentage: event.percentage }) as Record<string, unknown>,
      );
    } catch (error) {
      logger.error('Failed to record job progress', {
        jobId: event.jobId,
        error: (error as Error).message,
      });
    }
  });

  eventBus.get('job:cancel-requested').subscribe(async (event) => {
    try {
      const cancelled = await jobQueue.cancelPendingJobs(event.jobType);
      logger.info('Cancel requested', { jobType: event.jobType, cancelled });
      eventBus.get('job:cancel-ok').next({
        correlationId: event.correlationId,
        response: { cancelled },
      });
    } catch (error) {
      logger.error('Failed to cancel pending jobs', {
        jobType: event.jobType,
        error: (error as Error).message,
      });
      eventBus.get('job:cancel-failed').next({
        correlationId: event.correlationId,
        message: (error as Error).message,
      });
    }
  });
}
