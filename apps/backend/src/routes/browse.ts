/**
 * Browse Route
 *
 * GET /api/browse/files — list a project directory, merged with KB metadata.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import type { EventBus } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';
import { eventBusRequest } from '../utils/event-bus-request';

type BrowseRouterType = Hono<{ Variables: { user: User; eventBus: EventBus; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>;

const browseRouter: BrowseRouterType = new Hono<{ Variables: { user: User; eventBus: EventBus; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>();
browseRouter.use('/api/browse/*', authMiddleware);

browseRouter.get('/api/browse/files', async (c) => {
  const reqPath = c.req.query('path') ?? '';
  const sort    = c.req.query('sort') as 'name' | 'mtime' | 'annotationCount' | undefined;

  if (sort !== undefined && sort !== 'name' && sort !== 'mtime' && sort !== 'annotationCount') {
    throw new HTTPException(400, { message: 'Invalid sort value. Must be "name", "mtime", or "annotationCount".' });
  }

  const eventBus = c.get('eventBus');
  const correlationId = crypto.randomUUID();

  try {
    const response = await eventBusRequest(
      eventBus,
      'browse:directory-requested',
      { correlationId, path: reqPath, sort },
      'browse:directory-result',
      'browse:directory-failed',
    );
    return c.json(response);
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'TimeoutError') {
        throw new HTTPException(504, { message: 'Request timed out' });
      }
      if (error.message === 'path not found') {
        throw new HTTPException(404, { message: error.message });
      }
      if (error.message === 'path escapes project root') {
        throw new HTTPException(400, { message: error.message });
      }
    }
    throw error;
  }
});

export { browseRouter };
