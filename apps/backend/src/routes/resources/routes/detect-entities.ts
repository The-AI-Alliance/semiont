/**
 * Detect Entities Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 *
 * Non-SSE endpoint for creating entity detection jobs
 * For real-time progress updates, use the SSE equivalent:
 * POST /api/resources/{id}/detect-annotations-stream
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { ResourceQueryService } from '../../../services/resource-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { DetectionJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type DetectEntitiesRequest = components['schemas']['DetectEntitiesRequest'];
type CreateJobResponse = components['schemas']['CreateJobResponse'];

export function registerDetectEntities(router: ResourcesRouterType) {
  /**
   * POST /api/resources/:id/detect-entities
   *
   * Create an async entity detection job.
   * Use GET /api/jobs/{jobId} to poll status.
   * For real-time updates, use POST /api/resources/{id}/detect-annotations-stream instead.
   *
   * Requires authentication
   * Validates request body against DetectEntitiesRequest schema
   * Returns 201 with job details
   */
  router.post('/api/resources/:id/detect-entities',
    validateRequestBody('DetectEntitiesRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectEntitiesRequest;
      const { entityTypes } = body;

      console.log(`[DetectEntities] Creating detection job for resource ${id} with entity types:`, entityTypes);

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Validate resource exists using Layer 3
      const resource = await ResourceQueryService.getResourceMetadata(id);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      // Create a detection job
      const jobQueue = getJobQueue();
      const job: DetectionJob = {
        id: `job-${nanoid()}`,
        type: 'detection',
        status: 'pending',
        userId: user.id,
        resourceId: id,
        entityTypes,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };

      await jobQueue.createJob(job);
      console.log(`[DetectEntities] Created job ${job.id} for resource ${id}`);

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
