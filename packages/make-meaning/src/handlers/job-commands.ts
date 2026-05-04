import { generateUuid, jobId, userId, resourceId, entityType } from '@semiont/core';
import type { EventBus, Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import type { JobQueue } from '@semiont/jobs';
import { readTagSchemasProjection } from '../views/tag-schemas-reader.js';
import { readEntityTypesProjection } from '../views/entity-types-reader.js';

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
    const { correlationId, jobType, resourceId: resId, params, _userId } = command as Record<string, unknown>;

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
          maxRetries: jobType === 'generation' ? 3 : 1,
        },
        params: {
          resourceId: resourceId(resId as string),
          ...(params as Record<string, unknown>),
        } as Record<string, unknown>,
      };

      const jobParams = job.params as Record<string, unknown>;

      // Validate caller-supplied entity types against the per-KB
      // entity-type projection. Mirrors the tag-schema validation
      // below — unknown tags reject synchronously rather than letting
      // the worker stamp a resource (or annotation body) with a tag
      // that isn't part of the KB's declared vocabulary. Applies to
      // every jobType that surfaces `entityTypes` in `params`:
      //  - `reference-annotation` (mark.assist linking)
      //  - `generation` (yield.fromAnnotation)
      // Other jobTypes don't carry entityTypes through params and the
      // check is a no-op for them.
      if (
        (jobType === 'reference-annotation' || jobType === 'generation') &&
        Array.isArray(jobParams.entityTypes) &&
        jobParams.entityTypes.length > 0
      ) {
        const supplied = jobParams.entityTypes as string[];
        const registered = new Set(await readEntityTypesProjection(project));
        const unknown = supplied.filter((t) => !registered.has(t));
        if (unknown.length > 0) {
          throw new Error(`Entity type not registered: ${unknown.join(', ')}`);
        }
      }

      if (jobType === 'reference-annotation' && jobParams.entityTypes) {
        jobParams.entityTypes = (jobParams.entityTypes as string[]).map(et => entityType(et));
      }

      // Tag-annotation jobs: resolve the caller-supplied `schemaId` against
      // the per-KB tag-schema projection and embed the resolved schema in
      // the worker's params. Keeps the worker independent of the registry.
      if (jobType === 'tag-annotation') {
        const schemaId = jobParams.schemaId;
        if (typeof schemaId !== 'string' || !schemaId) {
          throw new Error('tag-annotation requires schemaId');
        }
        const schemas = await readTagSchemasProjection(project);
        const schema = schemas.find((s) => s.id === schemaId);
        if (!schema) {
          throw new Error(`Tag schema not registered: ${schemaId}`);
        }
        jobParams.schema = schema;
        delete jobParams.schemaId;
      }

      await jobQueue.createJob(job as never);

      logger.info('Job created via bus', { jobId: job.metadata.id, jobType, correlationId });

      (eventBus.get('job:created') as { next(v: unknown): void }).next({
        correlationId,
        response: { jobId: job.metadata.id },
      });
    } catch (error) {
      logger.error('job:create failed', { correlationId, error: (error as Error).message });
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
