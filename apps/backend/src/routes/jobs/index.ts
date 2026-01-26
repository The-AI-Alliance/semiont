/**
 * Jobs Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import { getJobQueue } from '@semiont/jobs';
import type { components } from '@semiont/api-client';
import { jobId } from '@semiont/api-client';

// Type for auth middleware - backend will provide this
type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

type JobStatusResponse = components['schemas']['JobStatusResponse'];

export function createJobsRouter(authMiddleware: AuthMiddleware) {
  // Create jobs router
  const jobsRouter = new Hono<{ Variables: { user: User } }>();

  // Apply auth middleware to all jobs routes
  jobsRouter.use('/api/jobs/*', authMiddleware);

  /**
   * GET /api/jobs/:id
   *
   * Get job status and progress
   * Requires authentication
   */
  jobsRouter.get('/api/jobs/:id', async (c) => {
    const { id } = c.req.param();
    const user = c.get('user');

    const jobQueue = getJobQueue();
    const job = await jobQueue.getJob(jobId(id));

    if (!job) {
      throw new HTTPException(404, { message: 'Job not found' });
    }

    // Verify user owns this job
    if (job.userId !== user.id) {
      throw new HTTPException(404, { message: 'Job not found' });
    }

    // All job types support progress and result
    const response: JobStatusResponse = {
      jobId: job.id,
      type: job.type,
      status: job.status,
      userId: job.userId,
      created: job.created,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      progress: (job as any).progress,
      result: (job as any).result,
    };

    return c.json(response);
  });

  return jobsRouter;
}
