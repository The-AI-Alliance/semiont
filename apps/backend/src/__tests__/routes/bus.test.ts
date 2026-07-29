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
    metadata: { sequenceNumber: seq } as EventMetadata,
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
  };
  return {
    id: `evt-${seq}`,
    type: 'yield:created',
    resourceId: makeResourceId(rIdStr),
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload,
    metadata: { sequenceNumber: seq } as EventMetadata,
  };
}


type Variables = { user: User; principalDid: string; eventBus: EventBusType; logger: ReturnType<typeof initializeLogger>; makeMeaning: unknown };

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

function buildApp(
  eventBus: EventBus,
  makeMeaning: unknown = fakeMakeMeaning(),
  options: { principalDid?: string } = {},
) {
  const passthrough = async (_c: unknown, next: () => Promise<void>) => next();
  const router = createBusRouter(passthrough as any);
  const app = new Hono<{ Variables: Variables }>();

  const logger = initializeLogger('error');
  const principalDid = options.principalDid ?? 'did:web:test.local:users:test%40test.local';
  app.use('*', async (c, next) => {
    c.set('user', fakeUser());
    c.set('principalDid', principalDid);
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

    // The bus reads `principalDid` off the request context (set by the
    // auth middleware) and stamps it onto every emitted payload as
    // `_userId`. The same code path applies whether the principal is a
    // human or a software agent — the agent identity flows through with
    // no special-casing. This is the load-bearing tenet for "humans and
    // agents as architectural equivalents."
    it('stamps `_userId` from the principal DID for a human caller', async () => {
      const received: any[] = [];
      eventBus.get('mark:added' as any).subscribe((v) => received.push(v));

      const humanApp = buildApp(eventBus, fakeMakeMeaning(), {
        principalDid: 'did:web:test.local:users:alice%40test.local',
      });
      const res = await humanApp.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'mark:added', payload: { annotationId: 'a-1' } }),
      });

      expect(res.status).toBe(202);
      expect(received).toHaveLength(1);
      expect(received[0]._userId).toBe('did:web:test.local:users:alice%40test.local');
    });

    it('stamps `_userId` from the principal DID for a software-agent caller', async () => {
      const received: any[] = [];
      eventBus.get('mark:added' as any).subscribe((v) => received.push(v));

      const agentDid = 'did:web:test.local:agents:ollama:gemma2%3A27b';
      const agentApp = buildApp(eventBus, fakeMakeMeaning(), { principalDid: agentDid });
      const res = await agentApp.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'mark:added', payload: { annotationId: 'a-1' } }),
      });

      expect(res.status).toBe(202);
      expect(received).toHaveLength(1);
      // Agent attribution flows through the SAME slot as human attribution —
      // no protocol-level distinction between the two at the bus seat.
      expect(received[0]._userId).toBe(agentDid);
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
          payload: { jobId: 'j-1', jobType: 'highlight-annotation', resourceId: 'res-1', userId: 'u-1' },
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

  // ── BUS-RESUMPTION.md behavior ────────────────────────────────────────

  const subscribe = (target: ReturnType<typeof buildApp>, body: unknown) =>
    target.request('/bus/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('SSE event-id stamping', () => {
    it('stamps ephemeral `id: e-<conn>-<n>` on global channel events', async () => {
      const res = await subscribe(app, { global: ['test:event'] });
      expect(res.status).toBe(200);

      // Emit after subscription has been set up (give the subscription a tick).
      setTimeout(() => {
        eventBus.get('test:event' as any).next({ x: 1 });
      }, 20);

      const body = await readSSE(res, (b) => b.includes('id: e-') && b.includes('test:event'));
      expect(body).toMatch(/id: e-[0-9a-f-]+-\d+/);
      expect(body).toContain('"channel":"test:event"');
    });

    it('stamps a DETERMINISTIC ephemeral `id: e-<channel>:<cid>` on a correlation reply', async () => {
      // A reply (correlationId-bearing payload) gets a connection-independent id
      // instead of the per-connection counter, so the make-before-break reconnect
      // overlap (subscribeToResource) dedups it by event id. A counter id would
      // differ across the two briefly-live connections and the same reply would
      // slip through twice (.plans/bugs/BRIDGE-GAPS.md).
      const res = await subscribe(app, { global: ['test:event'] });
      expect(res.status).toBe(200);

      setTimeout(() => {
        eventBus.get('test:event' as any).next({ correlationId: 'abc12345', response: {} });
      }, 20);

      const body = await readSSE(res, (b) => b.includes('id: e-test:event:'));
      expect(body).toContain('id: e-test:event:abc12345');
    });

    it('stamps persisted `id: p-<scope>-<seq>` on scoped events with a sequenceNumber', async () => {
      const res = await subscribe(app, {
        scoped: [{ scope: 'res-99', channels: ['mark:added'] }],
      });
      expect(res.status).toBe(200);

      setTimeout(() => {
        eventBus.scope('res-99').get('mark:added').next(fakeStoredMarkAdded(42, 'res-99', 'a-1'));
      }, 20);

      const body = await readSSE(res, (b) => b.includes('p-res-99-42'));
      expect(body).toMatch(/id: p-res-99-42/);
    });
  });

  describe('per-scope resumption (replay/live interleaving)', () => {
    // The basic replay / unparseable / scope-mismatch cases live in the
    // POST-matrix suite below (per-scope watermarks). This describe keeps
    // the replay-machinery cases: channel filtering, retention, and the
    // buffer-during-replay interleave/dedup properties.

    it("filters replayed events by the entry's `channels` set", async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        fakeStoredMarkAdded(8, 'res-1', 'keep-ann'),
        fakeStoredYieldCreated(9, 'skip-res'),
      ]);
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await subscribe(app2, {
        scoped: [{ scope: 'res-1', channels: ['mark:added'], lastEventId: 'p-res-1-7' }],
      });

      const body = await readSSE(res, (b) => b.includes('keep-ann'));
      expect(body).toContain('keep-ann');
      // yield:created isn't in the entry's channel set so it's filtered
      // out of the replay.
      expect(body).not.toContain('skip-res');
    });

    it('emits bus:resume-gap when the earliest stored event is past the requested sequence', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        fakeStoredMarkAdded(20, 'res-1', 'far-ahead'),
      ]);
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await subscribe(app2, {
        scoped: [{ scope: 'res-1', channels: ['mark:added'], lastEventId: 'p-res-1-7' }],
      });

      const body = await readSSE(res, (b) => b.includes('bus:resume-gap'));
      expect(body).toContain('"channel":"bus:resume-gap"');
      expect(body).toContain('"reason":"retention-exceeded"');
      expect(body).toContain('"scope":"res-1"');
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

      const res = await subscribe(app2, {
        scoped: [{ scope: 'res-1', channels: ['mark:added'], lastEventId: 'p-res-1-7' }],
      });

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

      const res = await subscribe(app2, {
        scoped: [{ scope: 'res-1', channels: ['mark:added'], lastEventId: 'p-res-1-7' }],
      });

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

  // ── MULTI-RESOURCE-SCOPE.md Step 3: POST subscription matrix ──────────

  describe('POST /bus/subscribe (multi-scope matrix)', () => {
    it("delivers each scope's events to a two-scope connection, tagged with the originating scope", async () => {
      const res = await subscribe(app, {
        scoped: [
          { scope: 'res-A', channels: ['mark:added'] },
          { scope: 'res-B', channels: ['mark:added'] },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      setTimeout(() => {
        eventBus.scope('res-A').get('mark:added').next(fakeStoredMarkAdded(1, 'res-A', 'ann-A'));
        eventBus.scope('res-B').get('mark:added').next(fakeStoredMarkAdded(1, 'res-B', 'ann-B'));
      }, 20);

      const body = await readSSE(res, (b) => b.includes('ann-A') && b.includes('ann-B'));
      expect(body).toContain('"scope":"res-A"');
      expect(body).toContain('"scope":"res-B"');
      expect(body).toMatch(/id: p-res-A-1/);
      expect(body).toMatch(/id: p-res-B-1/);
    });

    it("never leaks scope A's events to a connection subscribed only to scope B (no-leak, design principle 6)", async () => {
      const res = await subscribe(app, {
        scoped: [{ scope: 'res-B', channels: ['mark:added'] }],
      });
      expect(res.status).toBe(200);

      setTimeout(() => {
        // A's event first — if it were going to leak, it would arrive
        // before the B event the predicate waits on.
        eventBus.scope('res-A').get('mark:added').next(fakeStoredMarkAdded(1, 'res-A', 'leak-A'));
        eventBus.scope('res-B').get('mark:added').next(fakeStoredMarkAdded(1, 'res-B', 'keep-B'));
      }, 20);

      const body = await readSSE(res, (b) => b.includes('keep-B'));
      expect(body).toContain('keep-B');
      expect(body).not.toContain('leak-A');
    });

    it('mixes global channels and scoped entries on one connection', async () => {
      const res = await subscribe(app, {
        global: ['test:event'],
        scoped: [{ scope: 'res-A', channels: ['mark:added'] }],
      });
      expect(res.status).toBe(200);

      setTimeout(() => {
        eventBus.get('test:event' as never).next({ x: 1 } as never);
        eventBus.scope('res-A').get('mark:added').next(fakeStoredMarkAdded(1, 'res-A', 'ann-A'));
      }, 20);

      const body = await readSSE(res, (b) => b.includes('test:event') && b.includes('ann-A'));
      // Global event: no scope field, ephemeral id.
      expect(body).toMatch(/id: e-[0-9a-f-]+-\d+/);
      expect(body).toContain('"channel":"test:event"');
      // Scoped event: scope field + persisted id.
      expect(body).toContain('"scope":"res-A"');
    });

    it('replays per scope: a watermarked entry replays its gap, a fresh sibling entry stays silent', async () => {
      const queryEvents = vi.fn<QueryEventsStub>().mockResolvedValue([
        fakeStoredMarkAdded(8, 'res-1', 'replayed-1'),
      ]);
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await subscribe(app2, {
        scoped: [
          { scope: 'res-1', channels: ['mark:added'], lastEventId: 'p-res-1-7' },
          { scope: 'res-2', channels: ['mark:added'] },
        ],
      });

      const body = await readSSE(res, (b) => b.includes('replayed-1'));
      expect(queryEvents).toHaveBeenCalledTimes(1);
      expect(queryEvents).toHaveBeenCalledWith('res-1', { fromSequence: 8 });
      expect(body).toMatch(/id: p-res-1-8/);
      expect(body).not.toContain('bus:resume-gap');
    });

    it('emits a SCOPED bus:resume-gap for a mismatched watermark, leaving sibling scopes untouched', async () => {
      const queryEvents = vi.fn<QueryEventsStub>();
      const app2 = buildApp(eventBus, fakeMakeMeaning(queryEvents));

      const res = await subscribe(app2, {
        scoped: [
          // Watermark's embedded scope disagrees with the entry's scope.
          { scope: 'res-A', channels: ['mark:added'], lastEventId: 'p-res-B-3' },
          { scope: 'res-C', channels: ['mark:added'] },
        ],
      });

      const body = await readSSE(res, (b) => b.includes('bus:resume-gap'));
      expect(body).toContain('"reason":"scope-mismatch"');
      expect(body).toContain('"scope":"res-A"');
      expect(body).not.toContain('"scope":"res-C"');
      expect(queryEvents).not.toHaveBeenCalled();
    });

    it('emits a SCOPED bus:resume-gap for an unparseable watermark', async () => {
      const res = await subscribe(app, {
        scoped: [{ scope: 'res-A', channels: ['mark:added'], lastEventId: 'garbage' }],
      });

      const body = await readSSE(res, (b) => b.includes('bus:resume-gap'));
      expect(body).toContain('"reason":"unparseable-last-event-id"');
      expect(body).toContain('"scope":"res-A"');
    });

    it('rejects an empty matrix with 400', async () => {
      expect((await subscribe(app, {})).status).toBe(400);
      expect((await subscribe(app, { global: [], scoped: [] })).status).toBe(400);
    });

    it('rejects a malformed body with 400', async () => {
      const res = await app.request('/bus/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);
      expect((await subscribe(app, { scoped: [{ scope: 'res-A' }] })).status).toBe(400);
      expect((await subscribe(app, { scoped: [{ channels: ['x'] }] })).status).toBe(400);
      expect((await subscribe(app, { scoped: [{ scope: '', channels: ['x'] }] })).status).toBe(400);
    });

    it('rejects duplicate scopes with 400', async () => {
      const res = await subscribe(app, {
        scoped: [
          { scope: 'res-A', channels: ['mark:added'] },
          { scope: 'res-A', channels: ['mark:removed'] },
        ],
      });
      expect(res.status).toBe(400);
    });

    it('rejects a matrix above the 512-scope cap with 400', async () => {
      const scoped = Array.from({ length: 513 }, (_, i) => ({
        scope: `res-${i}`,
        channels: ['mark:added'],
      }));
      expect((await subscribe(app, { scoped })).status).toBe(400);
    });

    it('the GET form is gone (clean cutover — no back-compat)', async () => {
      const res = await app.request('/bus/subscribe?channel=test%3Aevent');
      expect(res.status).toBe(404);
    });
  });
});
