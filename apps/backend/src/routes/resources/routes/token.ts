/**
 * Token Routes
 *
 * Thin HTTP wrappers: emit yield:clone-* events on the EventBus,
 * await the CloneTokenManager's response.
 */

import { HTTPException } from 'hono/http-exception';
import { resourceId as makeResourceId, userId } from '@semiont/core';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { eventBusRequest } from '../../../utils/event-bus-request';

type CreateResourceFromTokenRequest = components['schemas']['CreateResourceFromTokenRequest'];

export function registerTokenRoutes(router: ResourcesRouterType) {
  /**
   * GET /api/clone-tokens/:token
   * Retrieve a resource using a clone token
   */
  router.get('/api/clone-tokens/:token', async (c) => {
    const { token } = c.req.param();
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'yield:clone-resource-requested',
        { correlationId, token },
        'yield:clone-resource-result',
        'yield:clone-resource-failed',
      );
      return c.json(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Invalid or expired token' || error.message === 'Token expired') {
          throw new HTTPException(404, { message: error.message });
        }
        if (error.message === 'Source resource not found') {
          throw new HTTPException(404, { message: error.message });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });

  /**
   * POST /api/clone-tokens/create-resource
   * Create a new resource using a clone token
   */
  router.post('/api/clone-tokens/create-resource',
    validateRequestBody('CreateResourceFromTokenRequest'),
    async (c) => {
      const body = c.get('validatedBody') as CreateResourceFromTokenRequest;
      const user = c.get('user');
      const eventBus = c.get('eventBus');
      const correlationId = crypto.randomUUID();

      try {
        const response = await eventBusRequest(
          eventBus,
          'yield:clone-create',
          {
            correlationId,
            token: body.token,
            name: body.name,
            content: body.content,
            userId: userId(user.id),
            archiveOriginal: body.archiveOriginal,
          },
          'yield:clone-created',
          'yield:clone-create-failed',
        );
        return c.json({ resourceId: response.resourceId }, 202);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'Invalid or expired token' || error.message === 'Token expired') {
            throw new HTTPException(404, { message: error.message });
          }
          if (error.message === 'Source resource not found') {
            throw new HTTPException(404, { message: error.message });
          }
          if (error.name === 'TimeoutError') {
            throw new HTTPException(504, { message: 'Request timed out' });
          }
        }
        throw error;
      }
    }
  );

  /**
   * POST /resources/:id/clone-with-token
   * Generate a temporary token for cloning a resource
   */
  router.post('/resources/:id/clone-with-token', async (c) => {
    const { id } = c.req.param();
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'yield:clone-token-requested',
        { correlationId, resourceId: makeResourceId(id) },
        'yield:clone-token-generated',
        'yield:clone-token-failed',
      );
      return c.json(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Resource not found' || error.message === 'Resource content not found') {
          throw new HTTPException(404, { message: error.message });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });
}
