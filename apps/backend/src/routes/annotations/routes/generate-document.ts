/**
 * Generate Document Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 *
 * Non-SSE endpoint for creating document generation jobs
 * For real-time progress updates, use the SSE equivalent:
 * POST /api/annotations/{id}/generate-document-stream
 */

import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { GenerationJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { compareAnnotationIds } from '@semiont/api-client';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';

type GenerateDocumentRequest = components['schemas']['GenerateDocumentRequest'];
type CreateJobResponse = components['schemas']['CreateJobResponse'];

export function registerGenerateDocument(router: AnnotationsRouterType) {
  /**
   * POST /api/annotations/:id/generate-document
   *
   * Create an async document generation job from an annotation.
   * Use GET /api/jobs/{jobId} to poll status.
   * For real-time updates, use POST /api/annotations/{id}/generate-document-stream instead.
   *
   * Requires authentication
   * Validates request body against GenerateDocumentRequest schema
   * Returns 201 with job details
   */
  router.post('/api/annotations/:id/generate-document',
    validateRequestBody('GenerateDocumentRequest'),
    async (c) => {
      const { id: annotationId } = c.req.param();
      const body = c.get('validatedBody') as GenerateDocumentRequest;

      console.log(`[GenerateDocument] Creating generation job for annotation ${annotationId} in document ${body.documentId}`);

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Validate annotation exists using Layer 3
      const projection = await AnnotationQueryService.getDocumentAnnotations(body.documentId);
      const annotation = projection.annotations.find((a: any) =>
        compareAnnotationIds(a.id, annotationId) && a.motivation === 'linking'
      );

      if (!annotation) {
        throw new HTTPException(404, { message: `Annotation ${annotationId} not found in document ${body.documentId}` });
      }

      // Create a generation job
      const jobQueue = getJobQueue();
      const job: GenerationJob = {
        id: `job-${nanoid()}`,
        type: 'generation',
        status: 'pending',
        userId: user.id,
        referenceId: annotationId,
        sourceDocumentId: body.documentId,
        title: body.title,
        prompt: body.prompt,
        language: body.language,
        entityTypes: getEntityTypes({ body: annotation.body }),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };

      await jobQueue.createJob(job);
      console.log(`[GenerateDocument] Created job ${job.id} for annotation ${annotationId}`);

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
