import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import type { EventBus, EventMap } from '@semiont/core';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

export function createBusRouter(authMiddleware: AuthMiddleware) {
  const busRouter = new Hono<{ Variables: { user: User; eventBus: EventBus } }>();

  busRouter.use('/bus/*', authMiddleware);

  busRouter.get('/bus/subscribe', (c) => {
    const channels = c.req.queries('channel') ?? [];
    const scope = c.req.query('scope');
    const eventBus = c.get('eventBus');

    if (channels.length === 0) {
      throw new HTTPException(400, { message: 'At least one channel parameter is required' });
    }

    return streamSSE(c, async (stream) => {
      const subs = channels.map((channel) => {
        const bus = scope ? eventBus.scope(scope) : eventBus;
        return bus.get(channel as keyof EventMap).subscribe((payload) => {
          stream.writeSSE({
            event: 'bus-event',
            data: JSON.stringify({ channel, payload, scope }),
          }).catch(() => {});
        });
      });

      stream.onAbort(() => subs.forEach((s) => s.unsubscribe()));

      while (true) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
    });
  });

  busRouter.post('/bus/emit', async (c) => {
    const eventBus = c.get('eventBus');
    const body = await c.req.json();
    const { channel, payload, scope } = body;

    if (!channel) {
      throw new HTTPException(400, { message: 'channel is required' });
    }
    if (!payload || typeof payload !== 'object') {
      throw new HTTPException(400, { message: 'payload must be an object' });
    }

    const bus = scope ? eventBus.scope(scope) : eventBus;
    const subject = bus.get(channel as keyof EventMap);
    subject.next(payload as never);

    return c.json(null, 202);
  });

  return busRouter;
}
