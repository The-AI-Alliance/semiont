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
import type { JobQueue } from '@semiont/jobs';
import type { components } from '@semiont/core';
import { jobId } from '@semiont/core';

// Type for auth middleware - backend will provide this
type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

type JobStatusResponse = components['schemas']['JobStatusResponse'];

export function createJobsRouter(jobQueue: JobQueue, authMiddleware: AuthMiddleware) {
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

    const job = await jobQueue.getJob(jobId(id));

    if (!job) {
      throw new HTTPException(404, { message: 'Job not found' });
    }

    // Verify user owns this job
    if (job.metadata.userId !== user.id) {
      throw new HTTPException(404, { message: 'Job not found' });
    }

    // Use discriminated union to safely access state-specific fields
    const response: JobStatusResponse = {
      jobId: job.metadata.id,
      type: job.metadata.type,
      status: job.status,
      userId: job.metadata.userId,
      created: job.metadata.created,
      startedAt: job.status === 'running' || job.status === 'complete' ? job.startedAt : undefined,
      completedAt: job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled' ? job.completedAt : undefined,
      error: job.status === 'failed' ? job.error : undefined,
      progress: job.status === 'running' ? job.progress : undefined,
      result: job.status === 'complete' ? job.result : undefined,
    };

    return c.json(response);
  });

  return jobsRouter;
}
