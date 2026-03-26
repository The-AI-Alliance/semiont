/**
 * Participant Attention Stream Route
 * GET /api/participants/me/attention-stream
 *
 * Opens a persistent SSE connection scoped to the authenticated participant.
 * Beckon signals sent via POST /api/participants/{id}/attention are pushed
 * here as 'beckon:focus' events. Signals are ephemeral — delivered if
 * connected, dropped if not. No queue, no replay.
 */

import { streamSSE } from 'hono/streaming';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EventBus } from '@semiont/core';
import { SSE_STREAM_CONNECTED } from '@semiont/api-client';
import { getOrCreateChannel, removeChannel } from '../attention-channels';
import { getLogger } from '../../../logger';

type ParticipantsRouterType = Hono<{ Variables: { user: User; eventBus: EventBus } }>;

export function registerAttentionStream(router: ParticipantsRouterType) {
  router.get('/api/participants/me/attention-stream', async (c) => {
    const user = c.get('user');
    const participantId = user.id;
    const logger = getLogger().child({ component: 'attention-stream', participantId });

    logger.info('Client connecting to attention stream');

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          timestamp: new Date().toISOString(),
          message: 'Attention stream connected',
        }),
        event: SSE_STREAM_CONNECTED,
        id: String(Date.now()),
      });

      let isStreamClosed = false;
      let keepAliveInterval: NodeJS.Timeout | null = null;
      let closeStreamCallback: (() => void) | null = null;

      const streamPromise = new Promise<void>((resolve) => {
        closeStreamCallback = resolve;
      });

      const cleanup = () => {
        if (isStreamClosed) return;
        isStreamClosed = true;
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        subscription.unsubscribe();
        removeChannel(participantId);
        closeStreamCallback?.();
      };

      const subject = getOrCreateChannel(participantId);
      const subscription = subject.subscribe(async (signal) => {
        if (isStreamClosed) return;
        try {
          await stream.writeSSE({
            data: JSON.stringify(signal),
            event: 'beckon:focus',
            id: String(Date.now()),
          });
        } catch (error) {
          logger.error('Error writing beckon signal to attention stream', { error });
          cleanup();
        }
      });

      keepAliveInterval = setInterval(async () => {
        if (isStreamClosed) {
          if (keepAliveInterval) clearInterval(keepAliveInterval);
          return;
        }
        try {
          await stream.writeSSE({ data: ':keep-alive' });
        } catch {
          cleanup();
        }
      }, 30000);

      c.req.raw.signal.addEventListener('abort', () => {
        logger.info('Client disconnected from attention stream');
        cleanup();
      });

      return streamPromise;
    });
  });
}
