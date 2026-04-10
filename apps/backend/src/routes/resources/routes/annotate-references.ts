// Replaces the former annotate-*-stream SSE route.

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { ResourceContext } from '@semiont/make-meaning';
import type { JobQueue, PendingJob, DetectionParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { jobId, entityType } from '@semiont/core';
import { userId, userToDid, resourceId } from '@semiont/core';
import { getLogger } from '../../../logger';

type AnnotateReferencesStreamRequest = components['schemas']['AnnotateReferencesStreamRequest'];

export function registerAnnotateReferences(router: ResourcesRouterType, jobQueue: JobQueue) {
  router.post('/resources/:id/annotate-references',
    validateRequestBody('AnnotateReferencesStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as AnnotateReferencesStreamRequest;
      const { entityTypes, includeDescriptiveReferences } = body;
      const logger = getLogger().child({
        component: 'annotate-references',
        resourceId: id
      });

      logger.info('Starting reference detection', {
        entityTypes,
        includeDescriptiveReferences
      });

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

      const job: PendingJob<DetectionParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'reference-annotation',
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
          entityTypes: entityTypes.map(et => entityType(et)),
          includeDescriptiveReferences
        }
      };

      await jobQueue.createJob(job);
      logger.info('Created detection job', { jobId: job.metadata.id, correlationId });

      return c.json({ correlationId, jobId: job.metadata.id }, 202);
    }
  );
}
