import { generateUuid, jobId, userId, resourceId, entityType, isGenerationJobParams } from '@semiont/core';
import type { EventBus, Logger } from '@semiont/core';
import type { SemiontState } from '@semiont/core/node';
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
  state: SemiontState,
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

      // GENERATION-WIRE-CONTEXT D1/D2: for generation, the context is the wire
      // truth — the job's resourceId is DERIVED from params.context.focus, and
      // caller-supplied ids are REJECTED (never ignored: a raw emitter must not
      // believe its ids mattered). Every OTHER jobType still requires the
      // envelope resourceId — the schema can't express the conditionality, so
      // both directions are enforced here.
      let effectiveResourceId: string;
      if (jobType === 'generation') {
        if (resId !== undefined) {
          throw new Error(
            'generation job:create must omit resourceId — the context\'s focus is authoritative',
          );
        }
        const bag = params as Record<string, unknown> | undefined;
        if (bag && bag.referenceId !== undefined) {
          throw new Error(
            'generation job:create must omit params.referenceId — the context\'s focus is authoritative',
          );
        }
        if (!isGenerationJobParams(params)) {
          throw new Error(
            'generation params do not satisfy GenerationJobParams (title, storageUri, and context are required)',
          );
        }
        const focus = (params.context as { focus?: Record<string, unknown> }).focus;
        const rid =
          focus?.kind === 'resource'
            ? (focus.resource as { '@id'?: unknown } | undefined)?.['@id']
            : focus?.kind === 'annotation'
              ? (focus.sourceResource as { '@id'?: unknown } | undefined)?.['@id']
              : undefined;
        if (typeof rid !== 'string' || rid.length === 0) {
          throw new Error(
            'generation context has no usable focus — pass a GatheredContext produced by '
            + 'gather.resource(...) or gather.annotation(...)',
          );
        }
        effectiveResourceId = rid;
      } else {
        if (typeof resId !== 'string' || resId.length === 0) {
          throw new Error(`${jobType} job:create requires resourceId`);
        }
        effectiveResourceId = resId;
      }

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
          resourceId: resourceId(effectiveResourceId),
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
      //  - `generation` (yield.fromContext)
      // The validator returns `{ ok: true }` for the no-tags-supplied
      // case, so the projection read only happens when there's
      // something to validate.
      if (
        (jobType === 'reference-annotation' || jobType === 'generation') &&
        Array.isArray(jobParams.entityTypes) &&
        jobParams.entityTypes.length > 0
      ) {
        const registered = await readEntityTypesProjection(state);
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
        const schemas = await readTagSchemasProjection(state);
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
      const outcome = await jobQueue.failJob(jobId(event.jobId), event.error, event.completedUnits, event.failureClass);
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

  // Durable checkpoint at unit completion (JOB-RESTART-SAFETY P2): persist the
  // finished units into the running job's metadata now, so a worker that dies
  // without emitting job:fail still leaves them for the janitor's recovery to
  // resume from. failJob carries the same checkpoint on a CLEAN failure; this
  // covers the crash path failJob never sees.
  eventBus.get('job:checkpoint').subscribe(async (event) => {
    try {
      await jobQueue.checkpointUnits(jobId(event.jobId), event.completedUnits);
    } catch (error) {
      logger.error('Failed to checkpoint job units', {
        jobId: event.jobId,
        error: (error as Error).message,
      });
    }
  });

  eventBus.get('job:cancel-requested').subscribe(async (event) => {
    try {
      let cancelled: number;
      if (event.jobId) {
        // Target one job (JOB-RESTART-SAFETY P4). A PENDING job is cancelled
        // here and now; a RUNNING job is left for its worker to stop
        // cooperatively (the worker is subscribed to this same signal and
        // emits job:cancel when it reaches a unit boundary) — cancelling it
        // here would yank it out from under a live worker.
        const target = await jobQueue.getJob(jobId(event.jobId));
        if (!target) {
          cancelled = 0;
        } else if (target.status === 'pending') {
          cancelled = (await jobQueue.cancelJob(jobId(event.jobId))) ? 1 : 0;
        } else if (target.status === 'running') {
          logger.info('Cancel of running job delegated to its worker', { jobId: event.jobId });
          cancelled = 1;
        } else {
          cancelled = 0; // already terminal
        }
        logger.info('Cancel requested', { jobId: event.jobId, cancelled });
      } else if (event.jobType) {
        cancelled = await jobQueue.cancelPendingJobs(event.jobType);
        logger.info('Cancel requested', { jobType: event.jobType, cancelled });
      } else {
        cancelled = 0;
      }
      eventBus.get('job:cancel-ok').next({
        correlationId: event.correlationId,
        response: { cancelled },
      });
    } catch (error) {
      logger.error('Failed to cancel jobs', {
        jobId: event.jobId,
        jobType: event.jobType,
        error: (error as Error).message,
      });
      eventBus.get('job:cancel-failed').next({
        correlationId: event.correlationId,
        message: (error as Error).message,
      });
    }
  });

  // A worker's confirmation that it stopped a running job cooperatively
  // (JOB-RESTART-SAFETY P4): move it to cancelled/, carrying the units it
  // checkpointed. This is the ONLY path that cancels a running job — a
  // running job is never yanked queue-side out from under its live worker.
  eventBus.get('job:cancel').subscribe(async (event) => {
    try {
      await jobQueue.cancelJob(jobId(event.jobId));
      logger.info('Job cancelled by its worker', { jobId: event.jobId });
    } catch (error) {
      logger.error('Failed to cancel job', {
        jobId: event.jobId,
        error: (error as Error).message,
      });
    }
  });
}
