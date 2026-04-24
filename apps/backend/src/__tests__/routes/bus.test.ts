import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { Annotation } from '@semiont/core';
import { EventBus, annotationId, resourceId as makeResourceId } from '@semiont/core';
import type { User } from '@prisma/client';
import type {
  EventBus as EventBusType,
  StoredEvent,
  EventOfType,
  UserId,
  EventMetadata,
  components,
} from '@semiont/core';
import { createBusRouter } from '../../routes/bus';
import { initializeLogger } from '../../logger';

const TEST_USER_ID = 'did:web:test:users:test' as UserId;

/**
 * Build a fully-typed StoredEvent<EventOfType<'mark:added'>> with
 * sensible defaults. Tests care about (sequenceNumber, annotation.id);
 * the rest of the shape is filled to match the OpenAPI schema so no
 * `as any` casts are needed.
 */
function fakeStoredMarkAdded(
  seq: number,
  rIdStr: string,
  annIdStr: string,
): StoredEvent<EventOfType<'mark:added'>> {
  const annotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(annIdStr),
    motivation: 'commenting',
    target: { source: rIdStr },
    body: [{ type: 'TextualBody', value: 'test comment', purpose: 'commenting' }],
  };
  return {
    id: `evt-${seq}`,
    type: 'mark:added',
    resourceId: makeResourceId(rIdStr),
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { annotation },
    metadata: { sequenceNumber: seq, streamPosition: seq - 1 } as EventMetadata,
  };
}

function fakeStoredYieldCreated(
  seq: number,
  rIdStr: string,
): StoredEvent<EventOfType<'yield:created'>> {
  const payload: components['schemas']['ResourceCreatedPayload'] = {
    name: `fake-${rIdStr}`,
    format: 'text/plain' as components['schemas']['ContentFormat'],
    contentChecksum: 'sha256:stub',
    creationMethod: 'api',
  };
  return {
    id: `evt-${seq}`,
    type: 'yield:created',
    resourceId: makeResourceId(rIdStr),
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload,
    metadata: { sequenceNumber: seq, streamPosition: seq - 1 } as EventMetadata,
  };
}


type Variables = { user: User; eventBus: EventBusType; logger: ReturnType<typeof initializeLogger>; makeMeaning: unknown };

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  initializeLogger('error');
});

function fakeUser(): User {
  return {
    id: 'user-1',
    email: 'test@test.local',
    name: 'Test',
    domain: 'test.local',
    provider: 'worker',
    isAdmin: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as User;
}

interface QueryEventsStub {
  (resourceId: string, filter?: { fromSequence?: number }): Promise<unknown[]>;
}

function fakeMakeMeaning(queryEvents: QueryEventsStub = async () => []) {
  return {
    knowledgeSystem: {
      kb: {
        eventStore: {
          log: {
            queryEvents,
          },
        },
      },
    },
  };
}

function buildApp(eventBus: EventBus, makeMeaning: unknown = fakeMakeMeaning()) {
  const passthrough = async (_c: unknown, next: () => Promise<void>) => next();
  const router = createBusRouter(passthrough as any);
  const app = new Hono<{ Variables: Variables }>();

  const logger = initializeLogger('error');
  app.use('*', async (c, next) => {
    c.set('user', fakeUser());
    c.set('eventBus', eventBus);
    c.set('logger', logger);
    c.set('makeMeaning', makeMeaning);
    await next();
  });
  app.route('/', router);
  return app;
}

/**
 * Drains the SSE response stream until `predicate` returns true or
 * `timeoutMs` elapses, then cancels the stream and returns the raw
 * accumulated text. Useful because Hono's streamSSE keeps the
 * connection open forever (heartbeat every 15s) so we can't just
 * `res.text()`.
 */
async function readSSE(
  res: Response,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 500,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const readerRace = Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), 50)),
      ]);
      const chunk = await readerRace;
      if (!chunk) continue;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (predicate(buffer)) break;
    }
  } finally {
    await reader.cancel();
  }
  return buffer;
}

describe('bus routes', () => {
  let eventBus: EventBus;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    eventBus = new EventBus();
    app = buildApp(eventBus);
  });

  describe('POST /bus/emit', () => {
    it('emits an event onto the bus and returns 202 for unvalidated channel', async () => {
      const received: unknown[] = [];
      eventBus.get('mark:added' as any).subscribe((v) => received.push(v));

      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'mark:added',
          payload: { annotationId: 'a-1' },
        }),
      });

      expect(res.status).toBe(202);
      expect(received).toHaveLength(1);
    });

    it('emits scoped events when scope is provided', async () => {
      const globalReceived: unknown[] = [];
      const scopedReceived: unknown[] = [];
      eventBus.get('mark:added' as any).subscribe((v) => globalReceived.push(v));
      eventBus.scope('res-42').get('mark:added' as any).subscribe((v) => scopedReceived.push(v));

      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'mark:added',
          payload: { annotationId: 'a-1' },
          scope: 'res-42',
        }),
      });

      expect(res.status).toBe(202);
      expect(scopedReceived).toHaveLength(1);
      expect(globalReceived).toHaveLength(0);
    });

    it('rejects missing channel with 400', async () => {
      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { x: 1 } }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing payload with 400', async () => {
      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'test:event' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects empty scope with 400', async () => {
      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'test:event', payload: { x: 1 }, scope: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid payload for validated channel with 400', async () => {
      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'mark:create',
          payload: { garbage: true },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Invalid payload for mark:create');
    });

    it('accepts valid payload for validated channel', async () => {
      const received: unknown[] = [];
      eventBus.get('job:queued' as any).subscribe((v) => received.push(v));

      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'job:queued',
          payload: { jobId: 'j-1', jobType: 'highlight-annotation', resourceId: 'res-1' },
        }),
      });

      expect(res.status).toBe(202);
      expect(received).toHaveLength(1);
    });

    it('rejects unknown channels with 400', async () => {
      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'custom:whatever',
          payload: { anything: 'goes' },
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /bus/subscribe', () => {
    it('rejects request with no channels with 400', async () => {
      const res = await app.request('/bus/subscribe');
      expect(res.status).toBe(400);
    });

    it('returns SSE content type', async () => {
      const res = await app.request('/bus/subscribe?channel=test%3Aevent');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });
  });

  // ── BUS-RESUMPTION.md behavior ────────────────────────────────────────

  describe('SSE event-id stamping', () => {
    it('stamps ephemeral `id: e-<conn>-<n>` on global channel events', async () => {
      const res = await app.request('/bus/subscribe?channel=test%3Aevent');
      expect(res.status).toBe(200);

      // Emit after subscription has been set up (give the subscription a tick).
      setTimeout(() => {
        eventBus.get('test:event' as any).next({ x: 1 });
      }, 20);

      const body = await readSSE(res, (b) => b.includes('id: e-') && b.includes('test:event'));
      expect(body).toMatch(/id: e-[0-9a-f-]+-\d+/);
      expect(body).toContain('"channel":"test:event"');
    });

    it('stamps persisted `id: p-<scope>-<seq>` on scoped events with a sequenceNumber', async () => {
      const res = await app.request(
        '/bus/subscribe?scope=res-99&scoped=mark%3Aadded',
      );
      expect(res.status).toBe(200);

      setTimeout(() => {
        eventBus.scope('res-99').get('mark:added').next(fakeStoredMarkAdded(42, 'res-99', 'a-1'));
      }, 20);

      const body = await readSSE(res, (b) => b.includes('p-res-99-42'));
      expect(body).toMatch(/id: p-res-99-42/);
    });
  });

  describe('Last-Event-ID resumption', () => {
    it('replays persisted events from the event store when Last-Event-ID is a valid p-<scope>-<seq>', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        fakeStoredMarkAdded(8, 'res-1', 'replayed-1'),
        fakeStoredMarkAdded(9, 'res-1', 'replayed-2'),
      ]);
      const mm = fakeMakeMeaning(queryEvents);
      const app2 = buildApp(eventBus, mm);

      const res = await app2.request(
        '/bus/subscribe?scope=res-1&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-1-7' } },
      );

      const body = await readSSE(res, (b) => b.includes('replayed-2'));
      expect(queryEvents).toHaveBeenCalledWith('res-1', { fromSequence: 8 });
      expect(body).toContain('replayed-1');
      expect(body).toContain('replayed-2');
      expect(body).toMatch(/id: p-res-1-8/);
      expect(body).toMatch(/id: p-res-1-9/);
    });

    it('filters replayed events by the subscribed `scoped=` channel set', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        fakeStoredMarkAdded(8, 'res-1', 'keep-ann'),
        fakeStoredYieldCreated(9, 'skip-res'),
      ]);
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await app2.request(
        '/bus/subscribe?scope=res-1&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-1-7' } },
      );

      const body = await readSSE(res, (b) => b.includes('keep-ann'));
      expect(body).toContain('keep-ann');
      // yield:created isn't in the subscribed `scoped=` set so it's
      // filtered out of the replay.
      expect(body).not.toContain('skip-res');
    });

    it('emits bus:resume-gap when the earliest stored event is past the requested sequence', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        fakeStoredMarkAdded(20, 'res-1', 'far-ahead'),
      ]);
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await app2.request(
        '/bus/subscribe?scope=res-1&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-1-7' } },
      );

      const body = await readSSE(res, (b) => b.includes('bus:resume-gap'));
      expect(body).toContain('"channel":"bus:resume-gap"');
      expect(body).toContain('"reason":"retention-exceeded"');
      expect(body).toContain('"scope":"res-1"');
    });

    it('emits bus:resume-gap for an unparseable Last-Event-ID', async () => {
      const res = await app.request('/bus/subscribe?channel=test%3Aevent', {
        headers: { 'Last-Event-ID': 'not-a-valid-id' },
      });

      const body = await readSSE(res, (b) => b.includes('bus:resume-gap'));
      expect(body).toContain('"reason":"unparseable-last-event-id"');
    });

    it('treats an ephemeral Last-Event-ID as "no resumption" (no gap event, no replay)', async () => {
      const queryEvents = vi.fn<QueryEventsStub>();
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await app2.request('/bus/subscribe?channel=test%3Aevent', {
        headers: { 'Last-Event-ID': 'e-abc123-5' },
      });

      setTimeout(() => eventBus.get('test:event' as any).next({ x: 1 }), 20);
      const body = await readSSE(res, (b) => b.includes('"channel":"test:event"'));

      expect(queryEvents).not.toHaveBeenCalled();
      expect(body).not.toContain('bus:resume-gap');
      expect(body).toContain('"channel":"test:event"');
    });

    it('emits bus:resume-gap when Last-Event-ID scope does not match the subscription scope', async () => {
      const res = await app.request(
        '/bus/subscribe?scope=res-DIFFERENT&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-original-3' } },
      );

      const body = await readSSE(res, (b) => b.includes('bus:resume-gap'));
      expect(body).toContain('"reason":"scope-mismatch"');
    });

    /**
     * End-to-end integration test for replay correctness.
     *
     * Simulates the full "client missed events during a disconnect, then
     * reconnected" scenario:
     *
     *   1. Three persisted events (seq 8,9,10) exist in the event store.
     *   2. Client reconnects with `Last-Event-ID: p-res-1-7`.
     *   3. While the server's replay query is executing (artificially
     *      slowed), two MORE live persisted events (seq 11,12) are
     *      emitted onto the scoped bus.
     *   4. Option A requires the server to: (a) subscribe to the live
     *      tail first so live events are captured during the replay
     *      window, (b) write replayed events in order, (c) drain
     *      buffered live events in order, (d) skip any live event whose
     *      seq was already covered by replay (should be none here, but
     *      the dedup machinery must be exercised).
     *
     * The assertion: all 5 event ids (p-res-1-8..12) appear in the SSE
     * output in strictly increasing sequence order, each exactly once.
     */
    it('delivers replay + live events interleaved correctly and without duplicates', async () => {
      const replayedEvents = [
        fakeStoredMarkAdded(8, 'res-1', 'r-8'),
        fakeStoredMarkAdded(9, 'res-1', 'r-9'),
        fakeStoredMarkAdded(10, 'res-1', 'r-10'),
      ];

      // Resolve the query only AFTER we've had a chance to emit live
      // events. This forces the server to be in the buffer-during-replay
      // window when the live events land.
      let resolveQuery: (events: unknown[]) => void;
      const queryEvents = vi.fn<QueryEventsStub>().mockImplementation(() => {
        return new Promise<unknown[]>((r) => {
          resolveQuery = r;
        });
      });
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await app2.request(
        '/bus/subscribe?scope=res-1&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-1-7' } },
      );

      // Let the subscribe handler set up its live subscription and start
      // the query. The query is hanging on `resolveQuery` — the server is
      // now in buffering mode.
      await new Promise((r) => setTimeout(r, 30));

      // Emit two live persisted events while replay is in-flight.
      eventBus.scope('res-1').get('mark:added').next(fakeStoredMarkAdded(11, 'res-1', 'live-11'));
      eventBus.scope('res-1').get('mark:added').next(fakeStoredMarkAdded(12, 'res-1', 'live-12'));

      // Now resolve the replay query. The server writes seq 8,9,10 to
      // the stream, then drains the buffered 11 and 12.
      resolveQuery!(replayedEvents);

      const body = await readSSE(res, (b) => b.includes('live-12'), 1500);

      // Extract ids in order from the SSE body.
      const ids = [...body.matchAll(/^id: (p-res-1-\d+)$/gm)].map((m) => m[1]);
      expect(ids).toEqual(['p-res-1-8', 'p-res-1-9', 'p-res-1-10', 'p-res-1-11', 'p-res-1-12']);

      // Each annotation.id appears exactly once (no duplicates from the
      // replay/live race).
      for (const expected of ['r-8', 'r-9', 'r-10', 'live-11', 'live-12']) {
        const matches = [...body.matchAll(new RegExp(`"id":"${expected}"`, 'g'))];
        expect(matches.length, `expected "${expected}" exactly once`).toBe(1);
      }
    });

    it('dedups events that appear both in replay and as live emissions', async () => {
      // This can happen if a persisted event was published to the bus
      // (live) AFTER the client's Last-Event-ID sequence but BEFORE the
      // live subscription was set up. The replay query returns it,
      // and the live subscription also fires for it. The server must
      // deliver it exactly once — writeBusEvent's per-scope seq tracking
      // enforces this.
      const replayedEvents = [fakeStoredMarkAdded(8, 'res-1', 'shared-ann')];

      let resolveQuery: (events: unknown[]) => void;
      const queryEvents = vi.fn<QueryEventsStub>().mockImplementation(() => {
        return new Promise<unknown[]>((r) => {
          resolveQuery = r;
        });
      });
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await app2.request(
        '/bus/subscribe?scope=res-1&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-1-7' } },
      );

      await new Promise((r) => setTimeout(r, 30));

      // Simulate the race: the same event fires live (buffered), and
      // the replay resolves with the same event.
      eventBus.scope('res-1').get('mark:added').next(fakeStoredMarkAdded(8, 'res-1', 'shared-ann'));
      resolveQuery!(replayedEvents);

      const body = await readSSE(res, (b) => b.includes('shared-ann'), 800);

      const matches = [...body.matchAll(/"id":"shared-ann"/g)];
      expect(matches.length).toBe(1);
      const ids = [...body.matchAll(/^id: (p-res-1-\d+)$/gm)].map((m) => m[1]);
      expect(ids).toEqual(['p-res-1-8']);
    });
  });
});
