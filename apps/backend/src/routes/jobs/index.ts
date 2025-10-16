import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import { getJobQueue } from '../../jobs/job-queue';

// Create jobs router with auth middleware
export const jobsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

/**
 * Job status response schema
 */
const JobStatusResponseSchema = z.object({
  jobId: z.string(),
  type: z.enum(['detection', 'generation']),
  status: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']),
  userId: z.string(),
  created: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  progress: z.any().optional(),
  result: z.any().optional(),
});

/**
 * GET /api/jobs/{id} - Get job status
 */
const getJobStatusRoute = createRoute({
  method: 'get',
  path: '/api/jobs/{id}',
  summary: 'Get Job Status',
  description: 'Get the current status and progress of an async job',
  tags: ['Jobs'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: JobStatusResponseSchema,
        },
      },
      description: 'Job status retrieved successfully',
    },
    404: {
      description: 'Job not found',
    },
  },
});

jobsRouter.openapi(getJobStatusRoute, async (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const jobQueue = getJobQueue();
  const job = await jobQueue.getJob(id);

  if (!job) {
    throw new HTTPException(404, { message: 'Job not found' });
  }

  // Verify user owns this job
  if (job.userId !== user.id) {
    throw new HTTPException(404, { message: 'Job not found' });
  }

  return c.json({
    jobId: job.id,
    type: job.type,
    status: job.status,
    userId: job.userId,
    created: job.created,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    progress: job.type === 'detection'
      ? (job as any).progress
      : job.type === 'generation'
        ? (job as any).progress
        : undefined,
    result: job.type === 'detection'
      ? (job as any).result
      : job.type === 'generation'
        ? (job as any).result
        : undefined,
  });
});
