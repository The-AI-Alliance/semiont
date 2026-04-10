// Replaces the former annotate-*-stream SSE route.

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { ResourceContext } from '@semiont/make-meaning';
import type { JobQueue, PendingJob, TagDetectionParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { jobId } from '@semiont/core';
import { userId, userToDid, resourceId } from '@semiont/core';
import { getTagSchema } from '@semiont/ontology';
import { getLogger } from '../../../logger';

type AnnotateTagsStreamRequest = components['schemas']['AnnotateTagsStreamRequest'];

export function registerAnnotateTags(router: ResourcesRouterType, jobQueue: JobQueue) {
  router.post('/resources/:id/annotate-tags',
    validateRequestBody('AnnotateTagsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as AnnotateTagsStreamRequest;
      const { schemaId, categories } = body;
      const logger = getLogger().child({
        component: 'annotate-tags',
        resourceId: id
      });

      logger.info('Starting tag detection', { schemaId, categories });

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const schema = getTagSchema(schemaId);
      if (!schema) {
        throw new HTTPException(400, { message: `Invalid tag schema: ${schemaId}` });
      }

      for (const category of categories) {
        if (!schema.tags.some(t => t.name === category)) {
          throw new HTTPException(400, { message: `Invalid category "${category}" for schema ${schemaId}` });
        }
      }

      if (categories.length === 0) {
        throw new HTTPException(400, { message: 'At least one category must be selected' });
      }

      const { knowledgeSystem: { kb } } = c.get('makeMeaning');

      const resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found in view storage projections - resource may need to be recreated' });
      }

      const correlationId = crypto.randomUUID();

      const job: PendingJob<TagDetectionParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'tag-annotation',
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
          schemaId,
          categories
        }
      };

      await jobQueue.createJob(job);
      logger.info('Created detection job', { jobId: job.metadata.id, correlationId });

      return c.json({ correlationId, jobId: job.metadata.id }, 202);
    }
  );
}
