/**
 * Exchange Routes — Knowledge Base Import/Export
 *
 * POST /api/admin/exchange/export — stream a backup or snapshot archive
 * POST /api/admin/exchange/import — upload a file and replay via EventBus
 *
 * Both routes require auth + admin middleware.
 */

import { Hono } from 'hono';
import { Readable, Writable } from 'node:stream';
import type { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { userId, type EnvironmentConfig, type EventBus } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';
import {
  exportBackup,
  exportSnapshot,
  importBackup,
  importSnapshot,
} from '@semiont/make-meaning';

type Variables = {
  user: User;
  config: EnvironmentConfig;
  eventBus: EventBus;
  makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
};

// Admin middleware (same pattern as routes/admin.ts)
const adminMiddleware = async (c: any, next: any) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }
  return next();
};

export const exchangeRouter = new Hono<{ Variables: Variables }>();
exchangeRouter.use('/api/admin/exchange/*', authMiddleware, adminMiddleware);

/**
 * POST /api/admin/exchange/export
 *
 * Streams a tar.gz (backup or snapshot) to the client.
 */
exchangeRouter.post('/api/admin/exchange/export', async (c) => {
  const { format, includeArchived } = await c.req.json<{
    format: 'backup' | 'snapshot';
    includeArchived?: boolean;
  }>();

  const mm = c.get('makeMeaning');
  const config = c.get('config');
  const sourceUrl = config.services?.backend?.publicURL ?? 'http://localhost:4000';

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `semiont-${format}-${timestamp}.tar.gz`;

  // Create a Node.js Writable that pushes chunks into a Web ReadableStream
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const webReadable = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });

  const nodeWritable = new Writable({
    write(chunk, _encoding, callback) {
      controller.enqueue(chunk);
      callback();
    },
    final(callback) {
      controller.close();
      callback();
    },
  });

  // Start the export in the background — it writes to nodeWritable which feeds webReadable
  const exportPromise = (async () => {
    try {
      if (format === 'backup') {
        await exportBackup(
          {
            eventStore: mm.kb.eventStore,
            content: mm.kb.content,
            sourceUrl,
          },
          nodeWritable,
        );
      } else {
        const entityTypes = await mm.graphDb.getEntityTypes();
        await exportSnapshot(
          {
            views: mm.kb.views,
            content: mm.kb.content,
            sourceUrl,
            entityTypes,
            includeArchived,
          },
          nodeWritable,
        );
      }
    } catch (err) {
      controller.error(err);
    }
  })();

  // Don't await exportPromise — it streams in the background
  void exportPromise;

  return new Response(webReadable, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-cache',
    },
  });
});

/**
 * POST /api/admin/exchange/import
 *
 * Accepts a multipart file upload and replays it through EventBus.
 * Returns SSE progress events.
 */
exchangeRouter.post('/api/admin/exchange/import', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const eventBus = c.get('eventBus');
  const user = c.get('user');
  const userDid = userId(user.id);

  const buffer = Buffer.from(await file.arrayBuffer());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Detect format: gzip starts with 0x1f 0x8b
        const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

        // Determine backup vs snapshot
        let isBackup = isGzip; // tar.gz files are typically backups
        if (!isGzip) {
          const firstLine = buffer.toString('utf8').split('\n')[0] ?? '';
          const header = JSON.parse(firstLine);
          isBackup = header.format === 'semiont-backup';
        }

        const input = new Readable({ read() {} });
        input.push(buffer);
        input.push(null);

        if (isBackup) {
          send({ phase: 'started', message: 'Importing backup...' });
          const result = await importBackup(input, { eventBus });
          send({
            phase: 'complete',
            result: {
              stats: result.stats,
              hashChainValid: result.hashChainValid,
            },
          });
        } else {
          send({ phase: 'started', message: 'Importing snapshot...' });
          const result = await importSnapshot(input, { eventBus, userId: userDid });
          send({
            phase: 'complete',
            result: {
              resourcesCreated: result.resourcesCreated,
              annotationsCreated: result.annotationsCreated,
              entityTypesAdded: result.entityTypesAdded,
            },
          });
        }
      } catch (err) {
        send({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
