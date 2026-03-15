/**
 * Exchange Routes — Knowledge Base Backup/Restore + Linked Data Export/Import
 *
 * Admin routes (require admin role):
 * POST /api/admin/exchange/backup  — stream a full backup archive
 * POST /api/admin/exchange/restore — upload a backup and replay via EventBus
 *
 * Moderator routes (require moderator or admin role):
 * POST /api/moderate/exchange/export  — stream a JSON-LD linked data archive
 * POST /api/moderate/exchange/import  — upload a JSON-LD archive and import via EventBus
 */

import { Hono } from 'hono';
import { Readable, Writable } from 'node:stream';
import type { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { userId as makeUserId } from '@semiont/core';
import type { EnvironmentConfig, EventBus } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';
import {
  exportBackup,
  importBackup,
  exportLinkedData,
  importLinkedData,
  readEntityTypesProjection,
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

// Moderator middleware (same pattern as routes/entity-types.ts)
const moderatorMiddleware = async (c: any, next: any) => {
  const user = c.get('user');
  if (!user || (!user.isModerator && !user.isAdmin)) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }
  return next();
};

export const exchangeRouter = new Hono<{ Variables: Variables }>();
exchangeRouter.use('/api/admin/exchange/*', authMiddleware, adminMiddleware);
exchangeRouter.use('/api/moderate/exchange/*', authMiddleware, moderatorMiddleware);

/**
 * POST /api/admin/exchange/backup
 *
 * Streams a tar.gz backup to the client.
 */
exchangeRouter.post('/api/admin/exchange/backup', async (c) => {
  const mm = c.get('makeMeaning');
  const config = c.get('config');
  const sourceUrl = config.services?.backend?.publicURL ?? 'http://localhost:4000';

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `semiont-backup-${timestamp}.tar.gz`;

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

  // Start the backup in the background — it writes to nodeWritable which feeds webReadable
  const exportPromise = (async () => {
    try {
      await exportBackup(
        {
          eventStore: mm.kb.eventStore,
          content: mm.kb.content,
          sourceUrl,
        },
        nodeWritable,
      );
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
 * POST /api/admin/exchange/restore
 *
 * Accepts a multipart file upload and replays the backup through EventBus.
 * Returns SSE progress events.
 */
exchangeRouter.post('/api/admin/exchange/restore', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const eventBus = c.get('eventBus');

  const buffer = Buffer.from(await file.arrayBuffer());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const input = new Readable({ read() {} });
        input.push(buffer);
        input.push(null);

        send({ phase: 'started', message: 'Restoring backup...' });
        const result = await importBackup(input, { eventBus });
        send({
          phase: 'complete',
          result: {
            stats: result.stats,
            hashChainValid: result.hashChainValid,
          },
        });
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

/**
 * POST /api/moderate/exchange/export
 *
 * Streams a JSON-LD linked data archive to the client.
 * Requires moderator or admin role.
 */
exchangeRouter.post('/api/moderate/exchange/export', async (c) => {
  const mm = c.get('makeMeaning');
  const config = c.get('config');
  const sourceUrl = config.services?.backend?.publicURL ?? 'http://localhost:4000';
  const includeArchived = c.req.query('includeArchived') === 'true';

  const entityTypes = await readEntityTypesProjection({
    services: { filesystem: config.services?.filesystem },
    _metadata: config._metadata,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `semiont-export-${timestamp}.tar.gz`;

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

  const exportPromise = (async () => {
    try {
      await exportLinkedData(
        {
          views: mm.kb.views,
          content: mm.kb.content,
          sourceUrl,
          entityTypes,
          includeArchived,
        },
        nodeWritable,
      );
    } catch (err) {
      controller.error(err);
    }
  })();

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
 * POST /api/moderate/exchange/import
 *
 * Accepts a multipart JSON-LD archive upload and imports via EventBus.
 * Requires moderator or admin role.
 * Returns SSE progress events.
 */
exchangeRouter.post('/api/moderate/exchange/import', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const eventBus = c.get('eventBus');
  const user = c.get('user');

  const buffer = Buffer.from(await file.arrayBuffer());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const input = new Readable({ read() {} });
        input.push(buffer);
        input.push(null);

        send({ phase: 'started', message: 'Importing linked data...' });
        const result = await importLinkedData(input, {
          eventBus,
          userId: makeUserId(user.id),
        });
        send({
          phase: 'complete',
          result: {
            resourcesCreated: result.resourcesCreated,
            annotationsCreated: result.annotationsCreated,
            entityTypesAdded: result.entityTypesAdded,
          },
        });
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
