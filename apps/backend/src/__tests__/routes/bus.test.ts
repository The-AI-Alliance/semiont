import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { EventBus } from '@semiont/core';
import type { User } from '@prisma/client';
import type { EventBus as EventBusType } from '@semiont/core';
import { createBusRouter } from '../../routes/bus';
import { initializeLogger } from '../../logger';

type Variables = { user: User; eventBus: EventBusType; logger: ReturnType<typeof initializeLogger> };

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

function buildApp(eventBus: EventBus) {
  const passthrough = async (_c: unknown, next: () => Promise<void>) => next();
  const router = createBusRouter(passthrough as any);
  const app = new Hono<{ Variables: Variables }>();

  const logger = initializeLogger('error');
  app.use('*', async (c, next) => {
    c.set('user', fakeUser());
    c.set('eventBus', eventBus);
    c.set('logger', logger);
    await next();
  });
  app.route('/', router);
  return app;
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
      eventBus.get('gather:complete' as any).subscribe((v) => received.push(v));

      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'gather:complete',
          payload: { correlationId: 'c-1', context: { summary: 'test' } },
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

    it('passes through unknown channels without validation', async () => {
      const received: unknown[] = [];
      eventBus.get('custom:whatever' as any).subscribe((v) => received.push(v));

      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'custom:whatever',
          payload: { anything: 'goes' },
        }),
      });

      expect(res.status).toBe(202);
      expect(received).toHaveLength(1);
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
});
