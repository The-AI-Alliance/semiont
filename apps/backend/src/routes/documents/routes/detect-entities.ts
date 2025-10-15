import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { DocumentsRouterType } from '../shared';
import { DocumentQueryService } from '../../../services/document-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { DetectionJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';

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
 * Non-SSE endpoint for creating entity detection jobs
 *
 * For real-time progress updates, use the SSE equivalent:
 * POST /api/documents/{id}/detect-annotations-stream
 */
export const detectEntitiesRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/detect-entities',
  summary: 'Detect Entities (Job)',
  description: 'Create an async entity detection job. Use GET /api/jobs/{jobId} to poll status. For real-time updates, use POST /api/documents/{id}/detect-annotations-stream instead.',
  tags: ['Documents', 'Annotations', 'Jobs'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            entityTypes: z.array(z.string()),
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
      description: 'Document not found',
    },
  },
});

export function registerDetectEntities(router: DocumentsRouterType) {
  router.openapi(detectEntitiesRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { entityTypes } = c.req.valid('json');

    console.log(`[DetectEntities] Creating detection job for document ${id} with entity types:`, entityTypes);

    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    // Validate document exists using Layer 3
    const document = await DocumentQueryService.getDocumentMetadata(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Create a detection job
    const jobQueue = getJobQueue();
    const job: DetectionJob = {
      id: `job-${nanoid()}`,
      type: 'detection',
      status: 'pending',
      userId: user.id,
      documentId: id,
      entityTypes,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await jobQueue.createJob(job);
    console.log(`[DetectEntities] Created job ${job.id} for document ${id}`);

    return c.json({
      jobId: job.id,
      status: job.status,
      type: job.type,
      created: job.created,
    }, 201);
  });
}
