/**
 * Beckon Route
 * POST /api/participants/{id}/attention
 *
 * Directs a participant's attention to a resource or annotation.
 * Produces no persistent annotations — attention signal only.
 * Pushes directly to the participant's open attention stream (if any).
 * Signals are ephemeral — delivered if connected, dropped if not.
 */

import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EventBus } from '@semiont/core';
import { resourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import { getOrCreateChannel } from '../attention-channels';

type BeckonRequest = components['schemas']['BeckonRequest'];

type ParticipantsRouterType = Hono<{ Variables: { user: User; eventBus: EventBus } }>;

export function registerBeckon(router: ParticipantsRouterType) {
  router.post('/api/participants/:id/attention',
    validateRequestBody('BeckonRequest'),
    async (c) => {
      const { id: participantId } = c.req.param();
      const request = c.get('validatedBody') as BeckonRequest;

      getOrCreateChannel(participantId).next({
        resourceId: request.resourceId,
        ...(request.annotationId ? { annotationId: request.annotationId } : {}),
      });

      return c.json({
        participant: participantId,
        resourceId: resourceId(request.resourceId),
        ...(request.annotationId ? { annotationId: request.annotationId } : {}),
      }, 202);
    }
  );
}
