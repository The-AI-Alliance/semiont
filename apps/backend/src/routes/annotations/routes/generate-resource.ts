/**
 * Generate Resource Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 *
 * Non-SSE endpoint for creating resource generation jobs
 * For real-time progress updates, use the SSE equivalent:
 * POST /api/annotations/{id}/generate-resource-stream
 */

import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { GenerationJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';
import { userId, resourceId } from '@semiont/core';

type GenerateResourceRequest = components['schemas']['GenerateResourceRequest'];
type CreateJobResponse = components['schemas']['CreateJobResponse'];

export function registerGenerateResource(router: AnnotationsRouterType) {
  /**
   * POST /api/annotations/:id/generate-resource
   *
   * Create an async resource generation job from an annotation.
   * Use GET /api/jobs/{jobId} to poll status.
   * For real-time updates, use POST /api/annotations/{id}/generate-resource-stream instead.
   *
   * Requires authentication
   * Validates request body against GenerateResourceRequest schema
   * Returns 201 with job details
   */
  router.post('/api/annotations/:id/generate-resource',
    validateRequestBody('GenerateResourceRequest'),
    async (c) => {
      const { id: annotationId } = c.req.param();
      const body = c.get('validatedBody') as GenerateResourceRequest;

      console.log(`[GenerateResource] Creating generation job for annotation ${annotationId} in resource ${body.resourceId}`);

      const user = c.get('user');
      const config = c.get('config');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Validate annotation exists using Layer 3
      const projection = await AnnotationQueryService.getResourceAnnotations(resourceId(body.resourceId), config);
      const annotation = projection.annotations.find((a: any) =>
        a.id === annotationId && a.motivation === 'linking'
      );

      if (!annotation) {
        throw new HTTPException(404, { message: `Annotation ${annotationId} not found in resource ${body.resourceId}` });
      }

      // Create a generation job
      const jobQueue = getJobQueue();
      const job: GenerationJob = {
        id: `job-${nanoid()}`,
        type: 'generation',
        status: 'pending',
        userId: userId(user.id),
        referenceId: annotationId,
        sourceResourceId: resourceId(body.resourceId),
        title: body.title,
        prompt: body.prompt,
        language: body.language,
        entityTypes: getEntityTypes({ body: annotation.body }),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };

      await jobQueue.createJob(job);
      console.log(`[GenerateResource] Created job ${job.id} for annotation ${annotationId}`);

      const response: CreateJobResponse = {
        jobId: job.id,
        status: job.status,
        type: job.type,
        created: job.created,
      };

      return c.json(response, 201);
    }
  );
}
