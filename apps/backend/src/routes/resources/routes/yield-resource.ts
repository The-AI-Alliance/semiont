/**
 * Yield Resource Route
 *
 * POST /resources/:resourceId/annotations/:annotationId/yield-resource
 *
 * Submits a resource generation command. Returns {correlationId} immediately.
 * The generation worker processes the job asynchronously and publishes
 * progress (yield:progress) and completion (yield:finished) or failure
 * (yield:failed) on the resource-scoped EventBus. Results reach all
 * connected clients via the long-lived events-stream.
 *
 * Replaces the former yield-resource-stream SSE route.
 * See .plans/UNIFIED-STREAM.md.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { AnnotationContext, ResourceContext } from '@semiont/make-meaning';
import type { JobQueue, PendingJob, GenerationParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { jobId, entityType } from '@semiont/core';
import { userId, userToDid, resourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';
import { getLogger } from '../../../logger';

type YieldResourceStreamRequest = components['schemas']['YieldResourceStreamRequest'];

export function registerYieldResource(router: ResourcesRouterType, jobQueue: JobQueue) {
  router.post('/resources/:resourceId/annotations/:annotationId/yield-resource',
    validateRequestBody('YieldResourceStreamRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const body = c.get('validatedBody') as YieldResourceStreamRequest;

      const logger = getLogger().child({
        component: 'yield-resource',
        resourceId: resourceIdParam,
        annotationId: annotationIdParam
      });

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const { knowledgeSystem: { kb } } = c.get('makeMeaning');

      // Validate annotation exists
      const projection = await AnnotationContext.getResourceAnnotations(resourceId(resourceIdParam), kb);
      const reference = projection.annotations.find((a: any) =>
        a.id === annotationIdParam && a.motivation === 'linking'
      );

      if (!reference) {
        throw new HTTPException(404, { message: `Annotation ${annotationIdParam} not found in resource ${resourceIdParam}` });
      }

      if (!body.context) {
        throw new HTTPException(400, { message: 'Context is required for generation' });
      }

      const correlationId = crypto.randomUUID();

      // Create the generation job
      const job: PendingJob<GenerationParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'generation',
          userId: userId(userToDid(user)),
          userName: user.name || user.email,
          userEmail: user.email,
          userDomain: user.domain,
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          referenceId: makeAnnotationId(annotationIdParam),
          sourceResourceId: resourceId(resourceIdParam),
          sourceResourceName: (await ResourceContext.getResourceMetadata(resourceId(resourceIdParam), kb))?.name || 'Unknown',
          annotation: reference,
          title: body.title,
          prompt: body.prompt,
          language: body.language,
          entityTypes: getEntityTypes(reference).map(et => entityType(et)),
          context: body.context,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          storageUri: body.storageUri,
        }
      };

      await jobQueue.createJob(job);
      logger.info('Created generation job', {
        jobId: job.metadata.id,
        correlationId,
        language: job.params.language,
      });

      // Progress (yield:progress), completion (yield:finished), and failure
      // (yield:failed) are emitted by the generation worker on the
      // resource-scoped bus. The events-stream delivers them to all clients.

      return c.json({ correlationId, jobId: job.metadata.id }, 202);
    }
  );
}
