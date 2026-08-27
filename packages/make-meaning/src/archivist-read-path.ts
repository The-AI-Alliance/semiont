/**
 * The Archivist's HTTP surface: the /health probe and the D1 sequence-ranged
 * event read path (EXTRACT-ARCHIVIST P2a).
 *
 * D1 (settled 2026-08-27): moving the event store out of the gateway breaks
 * `/bus/subscribe`'s `Last-Event-ID` replay, which reads the log in-process
 * (apps/backend/src/routes/bus.ts). The answer is this one narrow call —
 * the events for ONE resource from ONE sequence — which the gateway calls
 * directly:
 *
 *   GET /events/:resourceId?fromSequence=N   (inclusive, like the filter it
 *   mirrors: `queryEvents(rId, { fromSequence })`; the caller does the +1)
 *
 * ⚠️ STANDING RULE, load-bearing: this is a second protocol surface on the
 * Archivist beside the bus, and it stays justified only while it has
 * EXACTLY ONE customer — the gateway's SSE resume. A second customer
 * appearing here is the signal to re-examine the design, never to widen
 * the seam. Bus-replay and broker-replay alternatives were considered and
 * rejected with reasons in .plans/EXTRACT-ARCHIVIST.md; do not re-litigate
 * them here, and do not add endpoints.
 *
 * Auth: the gateway authenticates with the same SEMIONT_WORKER_SECRET the
 * agent-token flow uses — service-to-service, one shared deployment fact.
 * With no secret configured the read path refuses loudly (503) rather than
 * serving unauthenticated: absence fails, it is never a default-open.
 */

import { createServer, type Server } from 'http';
import type { Logger } from '@semiont/core';
import { resourceId as makeResourceId, errField } from '@semiont/core';
import type { EventLog } from '@semiont/event-sourcing';

export interface ArchivistServerDeps {
  /** The record's log — the read half only. */
  events: Pick<EventLog, 'queryEvents'>;
  /** Shared service secret; empty disables the read path (503), never opens it. */
  workerSecret: string;
  /** Liveness payload for /health — actor states, counters. */
  health: () => Record<string, unknown>;
  logger: Logger;
}

export function createArchivistServer(deps: ArchivistServerDeps): Server {
  const { events, workerSecret, health, logger } = deps;

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://archivist');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health()));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/events/')) {
      if (!workerSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'read path disabled: no SEMIONT_WORKER_SECRET configured' }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${workerSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const rawId = decodeURIComponent(url.pathname.slice('/events/'.length));
      const rawFrom = url.searchParams.get('fromSequence');
      const fromSequence = rawFrom === null ? NaN : Number(rawFrom);
      // The seam is sequence-ranged by definition — a missing fromSequence
      // would be a whole-log read, which is the widening this rule forbids.
      if (!rawId || !Number.isInteger(fromSequence) || fromSequence < 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'resourceId path segment and integer fromSequence >= 1 are required' }));
        return;
      }

      events.queryEvents(makeResourceId(rawId), { fromSequence })
        .then((replay) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ events: replay }));
        })
        .catch((error: unknown) => {
          logger.error('D1 read path failed', { resourceId: rawId, fromSequence, error: errField(error) });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'event read failed' }));
        });
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
