import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import type { EventBus, EventMap } from '@semiont/core';
import { userToDid } from '@semiont/core';
import { validateSchema } from '../utils/openapi-validator';
import { getLogger } from '../logger';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

const getBusLogger = () => getLogger().child({ component: 'bus' });

const CHANNEL_SCHEMAS: Record<string, string> = {
  // Mark flow — annotation commands
  'mark:create-request':      'MarkCreateRequest',
  'mark:create':              'MarkCreateCommand',
  'mark:delete':              'MarkDeleteCommand',
  'mark:update-body':         'MarkUpdateBodyCommand',
  'mark:archive':             'MarkArchiveCommand',
  'mark:unarchive':           'MarkUnarchiveCommand',
  'mark:add-entity-type':     'MarkAddEntityTypeCommand',
  'mark:update-entity-types': 'MarkUpdateEntityTypesCommand',
  'mark:progress':            'MarkProgress',
  'mark:assist-finished':     'MarkAssistFinished',
  'mark:assist-failed':       'MarkAssistFailed',
  'mark:assist-request':      'MarkAssistRequestEvent',

  // Yield flow — resource commands
  'yield:request':            'YieldRequestCommand',
  'yield:create':             'YieldCreateCommand',
  'yield:update':             'YieldUpdateCommand',
  'yield:mv':                 'YieldMvCommand',
  'yield:progress':           'YieldProgress',
  'yield:clone-token-requested': 'YieldCloneTokenRequest',
  'yield:clone-resource-requested': 'YieldCloneResourceRequest',
  'yield:clone-create':       'YieldCloneCreateCommand',

  // Bind flow
  'bind:initiate':            'BindInitiateCommand',
  'bind:update-body':         'BindUpdateBodyCommand',

  // Gather flow (summary)
  'gather:summary-requested': 'GatherSummaryRequest',

  // Match flow
  'match:search-requested':   'MatchSearchRequest',

  // Gather flow
  'gather:annotation-request': 'GatherAnnotationRequest',
  'gather:resource-request':   'GatherResourceRequest',

  // Browse flow — queries
  'browse:resources-requested':    'BrowseResourcesRequest',
  'browse:resource-requested':     'BrowseResourceRequest',
  'browse:annotations-requested':  'BrowseAnnotationsRequest',
  'browse:annotation-requested':   'BrowseAnnotationRequest',
  'browse:referenced-by-requested': 'BrowseReferencedByRequest',
  'browse:events-requested':       'BrowseEventsRequest',
  'browse:entity-types-requested': 'BrowseEntityTypesRequest',
  'browse:directory-requested':    'BrowseDirectoryRequest',
  'browse:annotation-history-requested': 'BrowseAnnotationHistoryRequest',
  'browse:annotation-context-requested': 'BrowseAnnotationContextRequest',

  // Job flow
  'job:queued':               'JobQueuedEvent',
  'job:start':                'JobStartCommand',
  'job:report-progress':      'JobReportProgressCommand',
  'job:complete':             'JobCompleteCommand',
  'job:fail':                 'JobFailCommand',
  'job:status-requested':     'JobStatusRequest',
  'job:cancel-requested':     'JobCancelRequest',
  'job:create':               'JobCreateCommand',
  'job:claim':                'JobClaimCommand',
};

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

    const schemaName = CHANNEL_SCHEMAS[channel];
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
