import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import { EventBus } from '@semiont/core';
import type { User } from '@prisma/client';
import type { EventBus as EventBusType } from '@semiont/core';
import { createBusRouter } from '../../routes/bus';
import { initializeLogger } from '../../logger';

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
        eventBus.scope('res-99').get('mark:added' as any).next({
          type: 'mark:added',
          metadata: { sequenceNumber: 42 },
          annotationId: 'a-1',
        } as any);
      }, 20);

      const body = await readSSE(res, (b) => b.includes('p-res-99-42'));
      expect(body).toMatch(/id: p-res-99-42/);
    });
  });

  describe('Last-Event-ID resumption', () => {
    it('replays persisted events from the event store when Last-Event-ID is a valid p-<scope>-<seq>', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        {
          type: 'mark:added',
          metadata: { sequenceNumber: 8 },
          annotationId: 'replayed-1',
        },
        {
          type: 'mark:added',
          metadata: { sequenceNumber: 9 },
          annotationId: 'replayed-2',
        },
      ]);
      const mm = fakeMakeMeaning(queryEvents);
      const app2 = buildApp(eventBus, mm);

      const res = await app2.request(
        '/bus/subscribe?scope=res-1&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-1-7' } },
      );

      const body = await readSSE(res, (b) => b.includes('replayed-2'));
      expect(queryEvents).toHaveBeenCalledWith('res-1', { fromSequence: 8 });
      expect(body).toContain('"annotationId":"replayed-1"');
      expect(body).toContain('"annotationId":"replayed-2"');
      expect(body).toMatch(/id: p-res-1-8/);
      expect(body).toMatch(/id: p-res-1-9/);
    });

    it('filters replayed events by the subscribed `scoped=` channel set', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        { type: 'mark:added', metadata: { sequenceNumber: 8 }, annotationId: 'keep' },
        { type: 'yield:created', metadata: { sequenceNumber: 9 }, resourceId: 'skip' },
      ]);
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await app2.request(
        '/bus/subscribe?scope=res-1&scoped=mark%3Aadded',
        { headers: { 'Last-Event-ID': 'p-res-1-7' } },
      );

      const body = await readSSE(res, (b) => b.includes('keep'));
      expect(body).toContain('"annotationId":"keep"');
      expect(body).not.toContain('"resourceId":"skip"');
    });

    it('emits bus:resume-gap when the earliest stored event is past the requested sequence', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        { type: 'mark:added', metadata: { sequenceNumber: 20 }, annotationId: 'far-ahead' },
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
  });
});
