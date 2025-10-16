import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { GenerationJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { compareAnnotationIds } from '@semiont/core';

/**
 * Response schema for job creation
 */
const CreateJobResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']),
  type: z.enum(['detection', 'generation']),
  created: z.string(),
});

/**
 * Non-SSE endpoint for creating document generation jobs
 *
 * For real-time progress updates, use the SSE equivalent:
 * POST /api/annotations/{id}/generate-document-stream
 */
export const generateDocumentRoute = createRoute({
  method: 'post',
  path: '/api/annotations/{id}/generate-document',
  summary: 'Generate Document (Job)',
  description: 'Create an async document generation job from an annotation. Use GET /api/jobs/{jobId} to poll status. For real-time updates, use POST /api/annotations/{id}/generate-document-stream instead.',
  tags: ['Selections', 'Documents', 'Jobs', 'AI'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Annotation ID'),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            documentId: z.string().describe('Document ID containing the annotation'),
            title: z.string().optional().describe('Custom title for generated document'),
            prompt: z.string().optional().describe('Custom prompt for content generation'),
            locale: z.string().optional().describe('Language locale (e.g., "es", "fr", "ja")'),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateJobResponseSchema,
        },
      },
      description: 'Job created successfully',
    },
    401: {
      description: 'Authentication required',
    },
    404: {
      description: 'Annotation not found',
    },
  },
});

export function registerGenerateDocument(router: AnnotationsRouterType) {
  router.openapi(generateDocumentRoute, async (c) => {
    const { id: annotationId } = c.req.valid('param');
    const body = c.req.valid('json');

    console.log(`[GenerateDocument] Creating generation job for annotation ${annotationId} in document ${body.documentId}`);

    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    // Validate annotation exists using Layer 3
    const projection = await AnnotationQueryService.getDocumentAnnotations(body.documentId);
    const annotation = projection.references.find((r: any) =>
      compareAnnotationIds(r.id, annotationId)
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
      locale: body.locale,
      entityTypes: annotation.body.entityTypes,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await jobQueue.createJob(job);
    console.log(`[GenerateDocument] Created job ${job.id} for annotation ${annotationId}`);

    return c.json({
      jobId: job.id,
      status: job.status,
      type: job.type,
      created: job.created,
    }, 201);
  });
}
