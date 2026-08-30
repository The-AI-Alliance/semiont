/**
 * The Archivist's HTTP surface: the /health probe, the D1 sequence-ranged
 * event read path (EXTRACT-ARCHIVIST P2a), and the content write and read
 * paths (SINGLE-KB-MOUNT P2/P3).
 *
 * ⚠️ STANDING RULE, load-bearing: **this surface serves the KB tree, and
 * nothing else.** `browse:*`, `match:*`, `gather:*` stay on the bus. The
 * earlier, narrower rule — exactly one customer, the gateway's SSE resume —
 * was re-examined by SINGLE-KB-MOUNT D1 (2026-08-29), which reversed
 * GATEWAY.md D4a: the Archivist is the knowledge base's storage authority,
 * and this HTTP surface is how bytes and record reads reach it (D2: bytes
 * ride HTTP, never the bus). That is a change of design, not a widened seam;
 * an endpoint that is not a KB-tree read or write still does not belong here.
 *
 * D1 (settled 2026-08-27): moving the event store out of the gateway breaks
 * `/bus/subscribe`'s `Last-Event-ID` replay, which reads the log in-process
 * (apps/backend/src/routes/bus.ts). The answer is one narrow call —
 * the events for ONE resource from ONE sequence — which the gateway calls
 * directly:
 *
 *   GET /events/:resourceId?fromSequence=N   (inclusive, like the filter it
 *   mirrors: `queryEvents(rId, { fromSequence })`; the caller does the +1)
 *
 * SINGLE-KB-MOUNT P2/P3: the gateway stops touching the shared mount for
 * bytes and proxies both directions here —
 *
 *   PUT /content/:storageUri[?checksum=sha256hex]   (storageUri URI-encoded
 *   as one path segment; an optional checksum is verified BEFORE anything is
 *   written, and a disagreement is a 409)
 *
 *   GET /resources/:id/content                      (the bytes, streamed,
 *   with the media type the record stores; the 404 carries `reason` so the
 *   gateway can serve its two different not-found messages)
 *
 * **The addresses differ because the lifecycle does**, not by oversight: at
 * write time neither the resource nor its view exists — bytes land before the
 * event — so the write has only a tree address to be addressed by, while the
 * read has a record. Both go through ONE resolution (`representation.ts`);
 * neither restates where bytes live.
 *
 * The write is `noGit` and emits nothing: the event contract is untouched —
 * the Stower still `register`s the bytes from disk and does the one `git add`
 * on event apply (GATEWAY.md D4b, single-writer).
 *
 * Auth: callers authenticate with the same SEMIONT_WORKER_SECRET the
 * agent-token flow uses — service-to-service, one shared deployment fact.
 * With no secret configured, every path but /health refuses loudly (503)
 * rather than serving unauthenticated: absence fails, it is never a
 * default-open.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { pipeline } from 'stream/promises';
import type { Logger } from '@semiont/core';
import { resourceId as makeResourceId, errField } from '@semiont/core';
import type { EventLog, ViewStorage } from '@semiont/event-sourcing';
import { ChecksumMismatchError, type WorkingTreeStore } from '@semiont/content';
import { resolveRepresentation, RepresentationMissing } from './representation';

export interface ArchivistServerDeps {
  /** The record's log — the read half only. */
  events: Pick<EventLog, 'queryEvents'>;
  /** The KB tree's byte paths. `register` and the git index stay the
   *  Stower's on event apply; reads go through `resolveRepresentation`. */
  content: Pick<WorkingTreeStore, 'store' | 'retrieveStream'>;
  /** The record's views — the resource half of the one resolution. */
  views: Pick<ViewStorage, 'get'>;
  /** Shared service secret; empty disables everything but /health (503), never opens it. */
  workerSecret: string;
  /** Liveness payload for /health — actor states, counters. */
  health: () => Record<string, unknown>;
  logger: Logger;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function createArchivistServer(deps: ArchivistServerDeps): Server {
  const { events, content, views, workerSecret, health, logger } = deps;

  /** The 503/401 posture every authenticated path shares. True = request may proceed. */
  const authorized = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!workerSecret) {
      json(res, 503, { error: 'disabled: no SEMIONT_WORKER_SECRET configured' });
      return false;
    }
    if (req.headers.authorization !== `Bearer ${workerSecret}`) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://archivist');

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, health());
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/events/')) {
      if (!authorized(req, res)) return;

      const rawId = decodeURIComponent(url.pathname.slice('/events/'.length));
      const rawFrom = url.searchParams.get('fromSequence');
      const fromSequence = rawFrom === null ? NaN : Number(rawFrom);
      // The seam is sequence-ranged by definition — a missing fromSequence
      // would be a whole-log read, which is the widening this rule forbids.
      if (!rawId || !Number.isInteger(fromSequence) || fromSequence < 1) {
        json(res, 400, { error: 'resourceId path segment and integer fromSequence >= 1 are required' });
        return;
      }

      events.queryEvents(makeResourceId(rawId), { fromSequence })
        .then((replay) => json(res, 200, { events: replay }))
        .catch((error: unknown) => {
          logger.error('D1 read path failed', { resourceId: rawId, fromSequence, error: errField(error) });
          json(res, 500, { error: 'event read failed' });
        });
      return;
    }

    // GET /resources/:id/content — the bytes, streamed, with the media type
    // the record stores. Addressed by resourceId because that is the key the
    // one resolution takes and the key `IContentTransport.getBinary` brings:
    // a caller never converts to a tree address only to have this side
    // convert back. Matched before the `/resources/` prefix is split so a
    // resourceId containing '/' cannot masquerade as another route.
    const contentMatch = req.method === 'GET' && /^\/resources\/(.+)\/content$/.exec(url.pathname);
    if (contentMatch) {
      if (!authorized(req, res)) return;

      const rid = decodeURIComponent(contentMatch[1]!);
      resolveRepresentation({ views, content }, makeResourceId(rid))
        .then(async ({ stream, mediaType }) => {
          res.writeHead(200, { 'Content-Type': mediaType });
          // Streamed, never buffered (D7): this process serves content for
          // every reader in the fleet, so its memory is bounded by the chunk.
          await pipeline(stream, res);
        })
        .catch((error: unknown) => {
          if (error instanceof RepresentationMissing) {
            // `reason` rides the wire because the gateway serves two
            // different client-visible messages for these two cases.
            json(res, 404, { error: error.message, reason: error.reason });
            return;
          }
          logger.error('Content read failed', { resourceId: rid, error: errField(error) });
          // A stream that failed mid-flight has already sent 200 and some
          // bytes; destroying the socket is the only honest signal left —
          // a truncated body must not look like a complete one.
          if (res.headersSent) res.destroy();
          else json(res, 500, { error: 'content read failed' });
        });
      return;
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/content/')) {
      if (!authorized(req, res)) return;

      const storageUri = decodeURIComponent(url.pathname.slice('/content/'.length));
      if (!storageUri) {
        json(res, 400, { error: 'storageUri path segment is required' });
        return;
      }
      const expectedChecksum = url.searchParams.get('checksum');

      // The request body streams straight into the store (D7: memory bounded
      // by the chunk, never the representation). The store writes beside the
      // target and renames only after the checksum agrees, so a disagreeing
      // body — or a torn upload — leaves nothing where the Stower's register
      // would find it.
      content.store(req, storageUri, {
        noGit: true,
        ...(expectedChecksum !== null ? { expectedChecksum } : {}),
      })
        .then((stored) => json(res, 200, stored))
        .catch((error: unknown) => {
          if (error instanceof ChecksumMismatchError) {
            json(res, 409, { error: 'checksum mismatch: body does not match the checksum the caller supplied' });
            return;
          }
          logger.error('Content write failed', { storageUri, error: errField(error) });
          json(res, 500, { error: 'content write failed' });
        });
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
