import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import type { EventBus, EventMap } from '@semiont/core';
import { CHANNEL_SCHEMAS, userToDid } from '@semiont/core';
import { validateSchema } from '../utils/openapi-validator';
import { getLogger } from '../logger';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

const getBusLogger = () => getLogger().child({ component: 'bus' });

export function createBusRouter(authMiddleware: AuthMiddleware) {
  const busRouter = new Hono<{ Variables: { user: User; eventBus: EventBus } }>();

  busRouter.use('/bus/*', authMiddleware);

  busRouter.get('/bus/subscribe', (c) => {
    const channels = c.req.queries('channel') ?? [];
    const scopedChannels = c.req.queries('scoped') ?? [];
    const scope = c.req.query('scope');
    const eventBus = c.get('eventBus');

    if (channels.length === 0 && scopedChannels.length === 0) {
      throw new HTTPException(400, { message: 'At least one channel or scoped parameter is required' });
    }

    return streamSSE(c, async (stream) => {
      const subs = channels.map((channel) => {
        return eventBus.get(channel as keyof EventMap).subscribe((payload) => {
          stream.writeSSE({
            event: 'bus-event',
            data: JSON.stringify({ channel, payload }),
          }).catch(() => {});
        });
      });

      if (scope && scopedChannels.length > 0) {
        const scopedBus = eventBus.scope(scope);
        for (const channel of scopedChannels) {
          subs.push(
            scopedBus.get(channel as keyof EventMap).subscribe((payload) => {
              stream.writeSSE({
                event: 'bus-event',
                data: JSON.stringify({ channel, payload, scope }),
              }).catch(() => {});
            })
          );
        }
      }

      stream.onAbort(() => subs.forEach((s) => s.unsubscribe()));

      while (true) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
    });
  });

  /**
   * Accepts bus events from clients. See `.plans/SIMPLE-BUS.md` for the
   * scope rule.
   *
   * - **Commands** (frontend → backend handler) and **correlation-ID
   *   responses** arrive un-scoped. Handlers subscribe on the global bus.
   * - **Resource-bound broadcasts** (WorkerVM-emitted progress for
   *   resource generation — the `RESOURCE_BROADCAST_TYPES` set) arrive
   *   with `scope: resourceId`. These are published on
   *   `eventBus.scope(resourceId)` so the per-resource SSE subscription
   *   can deliver them only to viewers of that resource.
   *
   * The `scope` parameter is **not** derived from any UI context — it is
   * meaningful only for publishers of resource-bound broadcasts. Frontend
   * commands must never set it.
   */
  busRouter.post('/bus/emit', async (c) => {
    const eventBus = c.get('eventBus');
    const body = await c.req.json();
    const { channel, payload, scope } = body;

    if (!channel || typeof channel !== 'string') {
      throw new HTTPException(400, { message: 'channel is required' });
    }
    if (!payload || typeof payload !== 'object') {
      throw new HTTPException(400, { message: 'payload must be an object' });
    }
    if (scope !== undefined && (typeof scope !== 'string' || scope === '')) {
      throw new HTTPException(400, { message: 'scope must be a non-empty string' });
    }

    if (!(channel in CHANNEL_SCHEMAS)) {
      throw new HTTPException(400, { message: `Unknown channel: ${channel}` });
    }
    const schemaName = CHANNEL_SCHEMAS[channel as keyof typeof CHANNEL_SCHEMAS];
    if (schemaName) {
      const { valid, errorMessage } = validateSchema(schemaName, payload);
      if (!valid) {
        getBusLogger().warn('Bus emit validation failed', { channel, scope, schemaName, errorMessage });
        throw new HTTPException(400, { message: `Invalid payload for ${channel}: ${errorMessage}` });
      }
    }

    const user = c.get('user') as User | undefined;
    if (user) {
      payload._userId = userToDid(user);
    }

    const bus = scope ? eventBus.scope(scope) : eventBus;
    const subject = bus.get(channel as keyof EventMap);
    subject.next(payload as never);

    getBusLogger().info('emit', { channel, scope, correlationId: (payload as Record<string, unknown>).correlationId });

    return c.json(null, 202);
  });

  return busRouter;
}
