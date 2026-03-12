/**
 * Jobs Routes
 *
 * Thin HTTP wrapper: emits job:status-requested on the EventBus,
 * awaits the response. User ownership check stays in the route
 * since auth is HTTP-only.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import { jobId } from '@semiont/core';
import { eventBusRequest } from '../../utils/event-bus-request';
import type { EventBus } from '@semiont/core';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

export function createJobsRouter(_jobQueue: any, authMiddleware: AuthMiddleware) {
  const jobsRouter = new Hono<{ Variables: { user: User; eventBus: EventBus } }>();
  jobsRouter.use('/api/jobs/*', authMiddleware);

  jobsRouter.get('/api/jobs/:id', async (c) => {
    const { id } = c.req.param();
    const user = c.get('user');
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'job:status-requested',
        { correlationId, jobId: jobId(id) },
        'job:status-result',
        'job:status-failed',
      );

      // Verify user owns this job (auth stays in the route)
      if (response.userId !== user.id) {
        throw new HTTPException(404, { message: 'Job not found' });
      }

      return c.json(response);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof Error) {
        if (error.message === 'Job not found') {
          throw new HTTPException(404, { message: 'Job not found' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });

  return jobsRouter;
}
