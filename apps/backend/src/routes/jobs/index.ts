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
import { authMiddleware } from '../../middleware/auth';
import { getJobQueue } from '../../jobs/job-queue';
import type { components } from '@semiont/api-client';
import { jobId } from '@semiont/api-client';

type JobStatusResponse = components['schemas']['JobStatusResponse'];

// Create jobs router
export const jobsRouter = new Hono<{ Variables: { user: User } }>();

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

  const response: JobStatusResponse = {
    jobId: job.id,
    type: job.type,
    status: job.status,
    userId: job.userId,
    created: job.created,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    progress: job.type === 'detection' || job.type === 'highlight-detection' || job.type === 'assessment-detection'
      ? (job as any).progress
      : job.type === 'generation'
        ? (job as any).progress
        : undefined,
    result: job.type === 'detection' || job.type === 'highlight-detection' || job.type === 'assessment-detection'
      ? (job as any).result
      : job.type === 'generation'
        ? (job as any).result
        : undefined,
  };

  return c.json(response);
});
