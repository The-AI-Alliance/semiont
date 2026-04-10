// Replaces the former annotate-*-stream SSE route. See .plans/UNIFIED-STREAM.md.

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { ResourceContext } from '@semiont/make-meaning';
import type { JobQueue, PendingJob, HighlightDetectionParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { jobId } from '@semiont/core';
import { userId, userToDid, resourceId } from '@semiont/core';
import { getLogger } from '../../../logger';

type AnnotateHighlightsStreamRequest = components['schemas']['AnnotateHighlightsStreamRequest'];

export function registerAnnotateHighlights(router: ResourcesRouterType, jobQueue: JobQueue) {
  router.post('/resources/:id/annotate-highlights',
    validateRequestBody('AnnotateHighlightsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as AnnotateHighlightsStreamRequest;
      const { instructions, density } = body;

      if (density !== undefined && (typeof density !== 'number' || density < 1 || density > 15)) {
        throw new HTTPException(400, { message: 'Invalid density. Must be a number between 1 and 15.' });
      }

      const logger = getLogger().child({
        component: 'annotate-highlights',
        resourceId: id
      });

      logger.info('Starting highlight detection', { instructions: !!instructions, density });

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const { knowledgeSystem: { kb } } = c.get('makeMeaning');

      const resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found in view storage projections - resource may need to be recreated' });
      }

      const correlationId = crypto.randomUUID();

      const job: PendingJob<HighlightDetectionParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'highlight-annotation',
          userId: userId(userToDid(user)),
          userName: user.name || user.email,
          userEmail: user.email,
          userDomain: user.domain,
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 1
        },
        params: {
          resourceId: resourceId(id),
          instructions,
          density
        }
      };

      await jobQueue.createJob(job);
      logger.info('Created detection job', { jobId: job.metadata.id, correlationId });

      return c.json({ correlationId, jobId: job.metadata.id }, 202);
    }
  );
}
