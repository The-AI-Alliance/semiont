import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { Annotation } from '@semiont/core';
import { EventBus, annotationId, isObject, resourceId as makeResourceId, userId } from '@semiont/core';
import type { Principal } from '../../identity/principal';
import type {
  EventBus as EventBusType,
  StoredEvent,
  EventOfType,
  UserId,
  EventMetadata,
  components,
} from '@semiont/core';
const observed = vi.hoisted(() => ({
  replySuppressed: vi.fn(),
  resumeGap: vi.fn(),
  unanswerable: vi.fn(),
}));
vi.mock('@semiont/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@semiont/observability')>()),
  recordReplySuppressed: (...args: unknown[]) => observed.replySuppressed(...args),
  recordResumeGap: (...args: unknown[]) => observed.resumeGap(...args),
  recordUnanswerableRequest: (...args: unknown[]) => observed.unanswerable(...args),
}));

import { createBusRouter } from '../../routes/bus';
import { LEDGER_TABLES, createCorrelationRegistry } from '../../signal/ledger';
import { createInProcessSignalPlane } from '../../signal/in-process';
import type { SharedTable, SignalPlane } from '../../signal/interface';
import { compositionFor } from '../../signal';
import { initializeLogger, getLogger } from '../../logger';

/**
 * Intercept every `getBusLogger()` call. The suite initializes the logger at
 * `error`, so a real `warn` would be filtered before reaching any transport —
 * spying on the child is what makes these observable at all.
 */
const captureBusWarnings = () => {
  const warn = vi.fn();
  vi.spyOn(getLogger(), 'child').mockReturnValue({
    warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as never);
  return warn;
};

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
    created: '2026-01-01T00:00:00.000Z',
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


type Variables = { principal: Principal; eventBus: EventBusType; logger: ReturnType<typeof initializeLogger>; config: unknown };

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  initializeLogger('error');
});

function fakeUser(): Principal {
  return {
    did: userId(`did:web:${'test.local'}:users:${encodeURIComponent('test@test.local')}`),
    email: 'test@test.local',
    name: 'Test',
    domain: 'test.local',
  } as Principal;
}

interface QueryEventsStub {
  (resourceId: string, filter?: { fromSequence?: number }): Promise<unknown[]>;
}

/**
 * Replay now reads the Archivist's D1 HTTP path (EXTRACT-ARCHIVIST P3), so
 * the stub lives behind a fetch double instead of an in-process kb. The
 * stub keeps the old (resourceId, { fromSequence }) call shape so the
 * assertions on WHAT was asked survive the transport change.
 */
const ARCHIVIST_HOST = 'archivist.test';
const ISSUER = 'https://issuer.test';
process.env.SEMIONT_OIDC_CLIENT_ID ??= 'semiont-gateway';
process.env.SEMIONT_OIDC_CLIENT_SECRET ??= 'bus-test-client-secret';

function withArchivistReplay(queryEvents: QueryEventsStub = async () => []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    // The hop to the Archivist authenticates with a service-account token now,
    // so the stub answers the issuer as well: discovery, then the grant.
    if (u.pathname.includes('/.well-known/openid-configuration')) {
      return Response.json({ issuer: ISSUER, token_endpoint: `${ISSUER}/token` });
    }
    if (u.pathname.endsWith('/token')) {
      return Response.json({ access_token: 'a-service-account-token', expires_in: 300 });
    }
    const rid = decodeURIComponent(u.pathname.slice('/events/'.length));
    const events = await queryEvents(rid, { fromSequence: Number(u.searchParams.get('fromSequence')) });
    return new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
}

function buildApp(
  eventBus: EventBus,
  options: { principalDid?: string } = {},
) {
  const passthrough = async (_c: unknown, next: () => Promise<void>) => next();
  const router = createBusRouter(passthrough as any);
  const app = new Hono<{ Variables: Variables }>();

  const logger = initializeLogger('error');
  const principalDid = options.principalDid ?? 'did:web:test.local:users:test%40test.local';
  app.use('*', async (c, next) => {
    c.set('principal', { ...fakeUser(), did: userId(principalDid) });
    c.set('eventBus', eventBus);
    c.set('logger', logger);
    c.set('config', { services: { archivist: { host: ARCHIVIST_HOST, port: 9999 }, identity: { issuer: ISSUER } } });
    // The credential the Archivist-dialling routes resolve. A test can now
    // supply its own — it could not while the value was read from process.env.
    c.set('archivistCredential', () => ({
      issuer: ISSUER,
      clientId: 'semiont-gateway',
      clientSecret: 'test-secret',
    }));
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

  // Presence is SSE CONNECTION LIFECYCLE, not login (D5): `semiont login`
  // hits REST and mints a token that may sit unused for hours, while what a
  // tour needs to know is whether anyone is WATCHING. The gateway already
  // tracked exactly that for its metrics gauge (recordSubscriberConnect /
  // recordSubscriberDisconnect) and threw the information away; these two
  // channels publish it.
  describe('presence', () => {
    it('announces session:joined with the participant DID when an SSE stream opens', async () => {
      const joined: any[] = [];
      eventBus.on('session:joined').subscribe((v) => joined.push(v));

      const res = await app.request('/bus/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'test-client', global: ['mark:added'], scoped: [] }),
      });
      await readSSE(res, () => joined.length > 0);

      expect(joined).toHaveLength(1);
      expect(joined[0].participant).toBe('did:web:test.local:users:test%40test.local');
    });

    it('announces session:left when the stream aborts', async () => {
      const left: any[] = [];
      eventBus.on('session:left').subscribe((v) => left.push(v));

      const res = await app.request('/bus/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'test-client', global: ['mark:added'], scoped: [] }),
      });
      // readSSE cancels the reader on the way out, which aborts the stream.
      await readSSE(res, () => false, 150);
      await vi.waitFor(() => expect(left).toHaveLength(1));
      expect(left[0].participant).toBe('did:web:test.local:users:test%40test.local');
    });

    // joined and left must name the SAME connection, or a guide watching two
    // viewers cannot tell which one left. The DID alone cannot do it: one
    // person with two tabs is two connections under one DID.
    // The 2026-09-03 OOM: a half-open socket (client container torn down
    // without a FIN) never errors and never closes, so no abort ever fires
    // — but its bus subscriptions keep fanning out, and every writeSSE
    // pends forever holding its full serialized frame. The pending-write
    // bound is the detector of last resort: past MAX_PENDING_WRITE_BYTES
    // the subscriber is torn down — unsubscribed, counted out of presence,
    // and its socket destroyed.
    it('disconnects a subscriber whose pending writes exceed the byte bound (dead consumer)', async () => {
      const left: unknown[] = [];
      eventBus.on('session:left').subscribe((v) => left.push(v));
      const destroy = vi.fn();

      const res = await app.request(
        '/bus/subscribe',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: 'test-client', global: ['test:event'] }),
        },
        // Stands in for @hono/node-server's HttpBindings: teardown must
        // hard-destroy the response socket, not just abandon the stream.
        { outgoing: { destroy } },
      );
      expect(res.status).toBe(200);
      // Let the stream callback run to its subscription setup.
      await new Promise((r) => setTimeout(r, 20));
      expect(eventBus.emit('test:event' as never, undefined as never)).toBe(1);

      // Nobody ever reads res.body — the consumer is dead. Fan out
      // payloads until the pending-write bound trips (16 MiB cap; a
      // couple of early chunks may clear before backpressure builds).
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 25; i++) {
        eventBus.emit('test:event' as never, { chunk } as never);
      }

      await vi.waitFor(() => expect(left).toHaveLength(1));
      expect(destroy).toHaveBeenCalled();
      // The dead connection's bus subscriptions are gone — fan-out to it
      // has stopped costing anything.
      expect(eventBus.emit('test:event' as never, undefined as never)).toBe(0);
    });

    it('pairs joined and left by connectionId', async () => {
      const joined: any[] = [];
      const left: any[] = [];
      eventBus.on('session:joined').subscribe((v) => joined.push(v));
      eventBus.on('session:left').subscribe((v) => left.push(v));

      const res = await app.request('/bus/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'test-client', global: ['mark:added'], scoped: [] }),
      });
      await readSSE(res, () => joined.length > 0);
      await vi.waitFor(() => expect(left).toHaveLength(1));

      expect(joined[0].connectionId).toBeTruthy();
      expect(left[0].connectionId).toBe(joined[0].connectionId);
    });
  });

  describe('POST /bus/emit', () => {
    // PERSON-PROFILE D3: the record learns what a person is called when that
    // person ACTS, and an emit is the act. The name rides its own system
    // event — never this payload, which carries only the DID.
    it('emits person:profile when the person WRITES, and not when they only read', async () => {
      const profiles: Array<{ name: string }> = [];
      eventBus.on('person:profile' as any).subscribe((p) => profiles.push(p as never));

      const emit = (channel: string, payload: Record<string, unknown>) => app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, payload }),
      });

      // A read carries a `_userId` exactly as a write does, which is why
      // stamping is not the test. Recording this would name every reader.
      await emit('browse:resources-requested', {});
      expect(profiles, 'reading is not an act').toEqual([]);

      // A write is.
      await emit('mark:delete', { resourceId: 'r-1', annotationId: 'a-1' });
      expect(profiles).toEqual([{ _userId: expect.any(String), name: 'Test' }]);
    });

    it('emits an event onto the bus and returns 202 for unvalidated channel', async () => {
      const received: unknown[] = [];
      eventBus.on('mark:added' as any).subscribe((v) => received.push(v));

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

    // An emit that reached nobody is the silent failure this route was
    // missing. `/bus/subscribe` enforces no allowlist and the emit handler
    // publishes unconditionally, so a client can emit a channel no
    // participant subscribes to, get a clean 202, and never learn that the
    // signal died in an empty subject. `warnIfUnobservedReply` cannot cover
    // it: that detector requires a `correlationId`, which fire-and-forget UI
    // signals (beckon, navigation) do not carry.
    //
    // The field is `subscribers`, NOT `delivered`: it is the observer count
    // at dispatch, and a subscriber can still drop the frame downstream.
    // Naming it after an outcome it cannot verify would be the same overclaim
    // this check exists to end.
    it('reports zero subscribers when nothing is listening', async () => {
      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'beckon:focus',
          payload: { annotationId: 'ann-1' },
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toEqual({ subscribers: 0 });
    });

    // ── TOUR-CLICK P6: the gateway's validation of `browse:click` ──────────
    //
    // P1 bound the channel to `BrowseClickEvent` in the registry
    // (`validate: "BrowseClickEvent"`), which is what makes /bus/emit willing
    // to accept it. Nothing proved the gateway HONORS that binding: the TS and
    // Go surfaces are pinned, `browse.click()`/`beckon.click()` are pinned at
    // the SDK, the viewer is pinned in react-ui — and a payload wrongly
    // accepted or rejected at this route fails none of them.
    //
    // These are regression pins, not discoveries. All three pass on landing;
    // that is the point. The wire boundary was simply unpinned.
    describe('browse:click validation (TOUR-CLICK P6)', () => {
      it('accepts a well-formed payload and reports the subscriber count', async () => {
        eventBus.on('browse:click').subscribe(() => {});

        const res = await app.request('/bus/emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: 'browse:click',
            payload: { annotationId: 'ann-1' },
          }),
        });

        expect(res.status).toBe(202);
        await expect(res.json()).resolves.toEqual({ subscribers: 1 });
      });

      // A 400 here means the binding is live. If this ever returns 202, the
      // registry's `validate` entry has stopped being enforced — which is the
      // regression this pin exists to catch, and the only way the binding's
      // deadness would ever show.
      it('rejects a payload missing annotationId', async () => {
        const res = await app.request('/bus/emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'browse:click', payload: {} }),
        });

        expect(res.status).toBe(400);
      });

      // Pins what the wire ACTUALLY does, not what one might wish it did.
      //
      // TOUR-CLICK D2 deleted `motivation` from this payload — the viewer
      // derives it from the annotation the id names. But `BrowseClickEvent`
      // declares no `additionalProperties: false`, so an extra field rides
      // through accepted. That is deliberate, not an oversight to fix here:
      // the registry's own TS binding is
      // `BrowseClickEvent & { anchorRect?: AnchorRect }` — the channel
      // deliberately carries a runtime-only local extra — so tightening the
      // schema is a wire change needing its own decision about how a
      // local-extra channel expresses that. Asserting the wish instead would
      // leave a failing or skipped test standing in for a decision nobody made.
      it('accepts an unknown extra field — the schema sets no additionalProperties bound', async () => {
        const res = await app.request('/bus/emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: 'browse:click',
            payload: { annotationId: 'ann-1', motivation: 'linking' },
          }),
        });

        expect(res.status).toBe(202);
      });
    });

    it('reports how many subscribers an emit reached', async () => {
      eventBus.on('beckon:focus').subscribe(() => {});
      eventBus.on('beckon:focus').subscribe(() => {});

      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'beckon:focus',
          payload: { annotationId: 'ann-1' },
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toEqual({ subscribers: 2 });
    });

    // Scope matters: a resource-scoped emit lands on the scoped subject, so
    // an unscoped subscriber is NOT a subscriber to it. Counting the global
    // subject here would report a healthy fan-out for a signal nobody scoped
    // will receive.
    it('counts subscribers on the SCOPED subject for a scoped emit', async () => {
      eventBus.on('beckon:focus').subscribe(() => {});

      const res = await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'beckon:focus',
          payload: { annotationId: 'ann-1' },
          scope: 'res-1',
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toEqual({ subscribers: 0 });
    });

    // The bus reads the principal off the request context (set by the
    // auth middleware) and stamps it onto every emitted payload as
    // `_userId`. The same code path applies whether the principal is a
    // human or a software agent — the agent identity flows through with
    // no special-casing. This is the load-bearing tenet for "humans and
    // agents as architectural equivalents."
    it('stamps `_userId` from the principal DID for a human caller', async () => {
      const received: any[] = [];
      eventBus.on('mark:added' as any).subscribe((v) => received.push(v));

      const humanApp = buildApp(eventBus, {
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
      eventBus.on('mark:added' as any).subscribe((v) => received.push(v));

      const agentDid = 'did:web:test.local:agents:ollama:gemma2%3A27b';
      const agentApp = buildApp(eventBus, { principalDid: agentDid });
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
      eventBus.on('mark:added' as any).subscribe((v) => globalReceived.push(v));
      eventBus.scope('res-42').on('mark:added' as any).subscribe((v) => scopedReceived.push(v));

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
      eventBus.on('job:queued' as any).subscribe((v) => received.push(v));

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

  // `clientId` is required on the subscribe body (P1 schema, enforced by P3).
  // Defaulted here so each test states only what it is about; a test that cares
  // passes its own, and the missing-clientId case calls `app.request` directly.
  const subscribe = (target: ReturnType<typeof buildApp>, body: Record<string, unknown>) =>
    target.request('/bus/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'test-client', ...body }),
    });

  describe('SSE event-id stamping', () => {
    it('stamps ephemeral `id: e-<conn>-<n>` on global channel events', async () => {
      const res = await subscribe(app, { global: ['test:event'] });
      expect(res.status).toBe(200);

      // Emit after subscription has been set up (give the subscription a tick).
      setTimeout(() => {
        eventBus.emit('test:event' as any, { x: 1 });
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
        eventBus.emit('test:event' as any, { response: {} }, { correlationId: 'abc12345' });
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
        eventBus.scope('res-99').emit('mark:added', fakeStoredMarkAdded(42, 'res-99', 'a-1'));
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
      withArchivistReplay(queryEvents);
      const app2 = buildApp(eventBus);

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
      withArchivistReplay(queryEvents);
      const app2 = buildApp(eventBus);

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
      withArchivistReplay(queryEvents);
      const app2 = buildApp(eventBus);

      const res = await subscribe(app2, {
        scoped: [{ scope: 'res-1', channels: ['mark:added'], lastEventId: 'p-res-1-7' }],
      });

      // Let the subscribe handler set up its live subscription and start
      // the query. The query is hanging on `resolveQuery` — the server is
      // now in buffering mode.
      await new Promise((r) => setTimeout(r, 30));

      // Emit two live persisted events while replay is in-flight.
      eventBus.scope('res-1').emit('mark:added', fakeStoredMarkAdded(11, 'res-1', 'live-11'));
      eventBus.scope('res-1').emit('mark:added', fakeStoredMarkAdded(12, 'res-1', 'live-12'));

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
      withArchivistReplay(queryEvents);
      const app2 = buildApp(eventBus);

      const res = await subscribe(app2, {
        scoped: [{ scope: 'res-1', channels: ['mark:added'], lastEventId: 'p-res-1-7' }],
      });

      await new Promise((r) => setTimeout(r, 30));

      // Simulate the race: the same event fires live (buffered), and
      // the replay resolves with the same event.
      eventBus.scope('res-1').emit('mark:added', fakeStoredMarkAdded(8, 'res-1', 'shared-ann'));
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
        eventBus.scope('res-A').emit('mark:added', fakeStoredMarkAdded(1, 'res-A', 'ann-A'));
        eventBus.scope('res-B').emit('mark:added', fakeStoredMarkAdded(1, 'res-B', 'ann-B'));
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
        eventBus.scope('res-A').emit('mark:added', fakeStoredMarkAdded(1, 'res-A', 'leak-A'));
        eventBus.scope('res-B').emit('mark:added', fakeStoredMarkAdded(1, 'res-B', 'keep-B'));
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
        eventBus.emit('test:event' as never, { x: 1 } as never);
        eventBus.scope('res-A').emit('mark:added', fakeStoredMarkAdded(1, 'res-A', 'ann-A'));
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
      withArchivistReplay(queryEvents);
      const app2 = buildApp(eventBus);

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
      withArchivistReplay(queryEvents);
      const app2 = buildApp(eventBus);

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

  // ── BUS-RESUMPTION.md Phase 2 (SDK-DEBT S1): correlated-reply retention ──

  // ── CORRELATED-REPLY-ROUTING P3 — the gateway claims and filters ──────
  //
  // A correlated reply must reach only the connection whose client issued
  // the request. Today every subscriber on the channel receives it and all
  // but one drop it after parsing — N x the serialization and N x the
  // buffered bytes, and every authenticated subscriber passively sees every
  // other user's reply payloads.
  describe('correlated-reply routing (P3)', () => {
    const REQ = 'gather:resource-requested'; // a registered request channel
    const RES = 'gather:resource-complete';  // its result channel

    const emit = (body: unknown) =>
      app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // D2 — the claim
    it('rejects a request-channel emit that carries a correlationId but no clientId (400)', async () => {
      const res = await emit({ channel: REQ, payload: { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } }, correlationId: 'c-1' });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/clientId/i);
    });

    it('rejects a second claim on a live correlationId (409)', async () => {
      const payload = { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } };
      const correlationId = 'c-dup';
      expect((await emit({ channel: REQ, payload, correlationId, clientId: 'client-a' })).status).toBe(202);
      const second = await emit({ channel: REQ, payload, correlationId, clientId: 'client-b' });
      expect(second.status).toBe(409);
    });

    // D2 — capacity is refused at the emit, never by evicting a live claim
    // (LIVENESS-AXIOMS L2: evicting a claim turns its future reply into a
    // silent drop, and the requester burns its whole timeout).
    it('refuses a claim beyond the per-client cap with 429 rather than evicting', async () => {
      // A handler must be PRESENT but silent. Capacity tracks UNANSWERED
      // requests (a settled claim releases its slot), and since
      // ARCHIVIST-STAYS-UP P3 a request reaching zero subscribers is answered
      // instantly with a synthesized failure — so shouting into a void no
      // longer accumulates anything. A client at capacity is one with many
      // requests genuinely in flight, which is what this now models.
      eventBus.on(REQ).subscribe(() => {});
      for (let i = 0; i < 256; i++) {
        const res = await emit({
          channel: REQ,
          payload: { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } },
          clientId: 'client-full', correlationId: `cap-${i}` });
        expect(res.status).toBe(202);
      }
      const overflow = await emit({
        channel: REQ,
        payload: { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } },
        clientId: 'client-full', correlationId: 'cap-256' });
      expect(overflow.status).toBe(429);
      // The first claim is still live — nothing was evicted to make room.
      expect((await emit({
        channel: REQ,
        payload: { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } },
        clientId: 'client-full', correlationId: 'cap-0' })).status).toBe(409);
    });

    // D3 — the delivery filter
    it('delivers a correlated reply only to the claiming client', async () => {
      const owner = await subscribe(app, { clientId: 'client-owner', global: [RES, 'test:event'] });
      const other = await subscribe(app, { clientId: 'client-other', global: [RES, 'test:event'] });
      await new Promise((r) => setTimeout(r, 20));

      await emit({ channel: REQ, payload: { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } }, clientId: 'client-owner', correlationId: 'c-routed' });

      setTimeout(() => {
        eventBus.emit(RES, { response: { ok: 1 } } as never, { correlationId: 'c-routed' });
        // A marker on an uncorrelated channel proves the non-owner's stream
        // is alive — otherwise "no reply" and "no connection" look alike.
        eventBus.emit('test:event' as never, { marker: 'alive' } as never);
      }, 10);

      const ownerBody = await readSSE(owner, (b) => b.includes('c-routed'));
      const otherBody = await readSSE(other, (b) => b.includes('alive'));

      expect(ownerBody).toContain('c-routed');
      expect(otherBody).toContain('alive');
      expect(otherBody).not.toContain('c-routed');
    });

    it('still fans a broadcast out to every subscriber', async () => {
      const a = await subscribe(app, { clientId: 'client-a', global: ['test:event'] });
      const b = await subscribe(app, { clientId: 'client-b', global: ['test:event'] });
      await new Promise((r) => setTimeout(r, 20));
      setTimeout(() => eventBus.emit('test:event' as never, { marker: 'broadcast' } as never), 10);
      expect(await readSSE(a, (x) => x.includes('broadcast'))).toContain('broadcast');
      expect(await readSSE(b, (x) => x.includes('broadcast'))).toContain('broadcast');
    });

    // D4 — the pendingReplies probe is owner-gated. Before this phase, reply
    // channels were global fan-out, so retention "added no exposure"; once
    // replies are routed, an ungated probe would be the one remaining way to
    // fish for another user's reply.
    it('refuses to replay a retained reply to a client that does not own the cid', async () => {
      await subscribe(app, { clientId: 'client-owner', global: [RES] });
      await emit({ channel: REQ, payload: { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } }, clientId: 'client-owner', correlationId: 'c-mine' });
      eventBus.emit(RES, { response: { ok: 1 } } as never, { correlationId: 'c-mine' });

      const thief = await subscribe(app, {
        clientId: 'client-thief',
        global: [RES, 'test:event'],
        pendingReplies: ['c-mine'],
      });
      setTimeout(() => eventBus.emit('test:event' as never, { marker: 'alive' } as never), 10);
      const body = await readSSE(thief, (x) => x.includes('alive'));
      expect(body).not.toContain('c-mine');
    });

    it('replays a retained reply to the client that does own it', async () => {
      await subscribe(app, { clientId: 'client-owner', global: [RES] });
      // A connected service takes the request, so it is not fast-failed; its
      // answer is the first, and so the retained, reply.
      const service = eventBus.on(REQ).subscribe(() => {});
      await emit({ channel: REQ, payload: { resourceId: 'r-1', options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false } }, clientId: 'client-owner', correlationId: 'c-ours' });
      eventBus.emit(RES, { response: { ok: 2 } } as never, { correlationId: 'c-ours' });
      service.unsubscribe();

      const back = await subscribe(app, {
        clientId: 'client-owner',
        global: [RES],
        pendingReplies: ['c-ours'],
      });
      const body = await readSSE(back, (x) => x.includes('c-ours'));
      expect(body).toContain(`id: e-${RES}:c-ours`);
    });

    it('requires clientId on the subscribe body (400)', async () => {
      const res = await app.request('/bus/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global: ['test:event'] }),   // deliberately absent
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/clientId/i);
    });
  });

  // ── CORRELATED-REPLY-ROUTING P5 — observability ───────────────────────
  //
  // A counter that is wired but never incremented is exactly the defect an
  // observability phase exists to prevent, and nothing else in the stack
  // would notice. Same for a breadcrumb: unpinned, it is one refactor from
  // silence, and these three are the plan's entire L4 story.
  describe('observability (P5)', () => {
    const REQ = 'gather:resource-requested';
    const RES = 'gather:resource-complete';
    const OPTS = { depth: 1, maxResources: 1, includeContent: false, includeSummary: false };


    const emit = (body: unknown) =>
      app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('counts a suppression when a reply is withheld from a non-owner', async () => {
      observed.replySuppressed.mockClear();
      await subscribe(app, { clientId: 'client-owner', global: [RES] });
      const other = await subscribe(app, { clientId: 'client-other', global: [RES, 'test:event'] });
      await new Promise((r) => setTimeout(r, 20));

      await emit({ channel: REQ, clientId: 'client-owner', payload: { resourceId: 'r-1', options: OPTS }, correlationId: 'c-count' });
      setTimeout(() => {
        eventBus.emit(RES, { response: { ok: 1 } } as never, { correlationId: 'c-count' });
        eventBus.emit('test:event' as never, { marker: 'alive' } as never);
      }, 10);
      await readSSE(other, (b) => b.includes('alive'));

      expect(observed.replySuppressed).toHaveBeenCalled();
      expect(observed.replySuppressed.mock.calls[0]?.[0]).toBe(RES);
    });

    // The owner's own delivery is not a suppression. Counting it would make
    // the metric a channel-traffic gauge rather than the amplification signal.
    it('does not count the owner\'s own delivery', async () => {
      const owner = await subscribe(app, { clientId: 'client-solo', global: [RES] });
      await new Promise((r) => setTimeout(r, 20));
      await emit({ channel: REQ, clientId: 'client-solo', payload: { resourceId: 'r-1', options: OPTS }, correlationId: 'c-solo' });
      observed.replySuppressed.mockClear();
      setTimeout(() => eventBus.emit(RES, { response: { ok: 1 } } as never, { correlationId: 'c-solo' }), 10);
      await readSSE(owner, (b) => b.includes('c-solo'));

      expect(observed.replySuppressed).not.toHaveBeenCalled();
    });

    // The structural case: an in-process requester never claims, so its reply
    // reaches no connection. That fires constantly and is not the
    // amplification being removed — counting it would drown the signal P6
    // reads, the same reason D3 refuses to breadcrumb it.
    it('does not count a never-claimed cid', async () => {
      const sub = await subscribe(app, { clientId: 'client-x', global: [RES, 'test:event'] });
      await new Promise((r) => setTimeout(r, 20));
      observed.replySuppressed.mockClear();
      setTimeout(() => {
        eventBus.emit(RES, { response: {} } as never, { correlationId: 'never-claimed' });
        eventBus.emit('test:event' as never, { marker: 'alive' } as never);
      }, 10);
      await readSSE(sub, (b) => b.includes('alive'));

      expect(observed.replySuppressed).not.toHaveBeenCalled();
    });

    it('the emit log line carries the clientId', async () => {
      const warn = captureBusWarnings();
      const infoed: unknown[] = [];
      vi.spyOn(getLogger(), 'child').mockReturnValue({
        warn, error: vi.fn(), debug: vi.fn(),
        info: (msg: string, meta: unknown) => { infoed.push({ msg, meta }); },
      } as never);

      await emit({ channel: REQ, clientId: 'client-logged', payload: { resourceId: 'r-1', options: OPTS }, correlationId: 'c-log' });
      const emitLine = infoed.find((e) => (e as { msg?: string }).msg === 'emit') as { meta?: Record<string, unknown> } | undefined;
      expect(emitLine?.meta?.clientId).toBe('client-logged');
    });

    // ── The three L4 breadcrumbs, inherited unpinned from P3 ─────────────

    it('[bus REPLY-NO-CID] fires for a result frame with no correlationId', async () => {
      const warn = captureBusWarnings();
      await subscribe(app, { clientId: 'client-nocid', global: [RES] });
      await new Promise((r) => setTimeout(r, 20));
      eventBus.emit(RES, { response: { ok: 1 } } as never); // no cid
      await new Promise((r) => setTimeout(r, 20));

      expect(warn.mock.calls.some((c) => String(c[0]).includes('REPLY-NO-CID'))).toBe(true);
    });

    it('[bus CLAIM-EXPIRED] fires when a claim is swept with no reply', async () => {
      const warn = captureBusWarnings();
      let clock = 1_000;
      const registry = createCorrelationRegistry(createInProcessSignalPlane(new EventBus()), { claimTtlMs: 100, now: () => clock });
      await registry.claim('c-silent', 'client-1', 'did:web:x');

      clock += 101;
      await registry.claim('c-next', 'client-1', 'did:web:x'); // any claim sweeps first

      expect(warn.mock.calls.some((c) => String(c[0]).includes('CLAIM-EXPIRED'))).toBe(true);
      registry.dispose();
    });

    it('[bus CLAIM-EVICTED] fires when the global cap forces an eviction', async () => {
      const warn = captureBusWarnings();
      const registry = createCorrelationRegistry(createInProcessSignalPlane(new EventBus()), { now: () => 1 });
      // Fill past the global backstop, spread across clients so the per-client
      // cap refuses nothing — the global cap is what must trip.
      for (let i = 0; i <= 4096; i++) {
        await registry.claim(`g-${i}`, `client-${Math.floor(i / 100)}`, 'did:web:x');
      }
      expect(warn.mock.calls.some((c) => String(c[0]).includes('CLAIM-EVICTED'))).toBe(true);
      registry.dispose();
    });
  });

  // ── ARCHIVIST-STAYS-UP P3 — an unanswerable request fails fast ────────
  //
  // An absent Archivist wedges every browse:* read silently: the gateway sees
  // nothing subscribed, logs it, and returns 202 anyway, so the caller burns
  // its full 30 s timeout. busRequest has no retry, so that timeout is
  // terminal either way — the difference is milliseconds and a name instead
  // of thirty seconds and a hang.
  describe('unanswerable request fails fast (ARCHIVIST-STAYS-UP P3)', () => {
    const REQ = 'gather:resource-requested';
    const FAILED = 'gather:resource-failed';
    const OPTS = { depth: 1, maxResources: 1, includeContent: false, includeSummary: false };

    const emit = (body: unknown) =>
      app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('synthesizes the mapped *-failed when a request reaches zero subscribers', async () => {
      const failures: { correlationId?: string; payload: { message?: string } }[] = [];
      eventBus.frames(FAILED).subscribe((f) => failures.push(f));

      const res = await emit({
        channel: REQ,
        clientId: 'client-a',
        payload: { resourceId: 'r-1', options: OPTS }, correlationId: 'c-nobody' });

      expect(res.status).toBe(202);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.correlationId).toBe('c-nobody');
      expect(String(failures[0]?.payload.message)).toMatch(/subscrib/i);
    });

    it("carries code 'peer-unavailable' — the class, not just the sentence", async () => {
      // The gateway already RECORDED this condition for metrics
      // (`recordUnanswerableRequest` → `semiont_bus_unanswerable_total`) and could
      // not tell the caller. A consumer wanting to distinguish "the peer has not
      // connected yet" from "the command was refused" had to match a substring —
      // which is why the weaver's boot passes treated a startup race as a
      // permanent data condition and gave up (2026-09-09).
      const failures: Record<string, unknown>[] = [];
      eventBus.on(FAILED).subscribe((v) => failures.push(v as Record<string, unknown>));

      await emit({
        channel: REQ,
        clientId: 'client-code',
        payload: { resourceId: 'r-3', options: OPTS }, correlationId: 'c-coded' });

      expect(failures[0]?.code).toBe('peer-unavailable');
    });

    // Without the cid the frame is dropped by the delivery filter as a
    // REPLY-SHAPE violation — the failure would be synthesized and then
    // silently discarded, in exactly the outage this phase exists for.
    it('carries the request correlationId, so owner-routing can deliver it', async () => {
      const failures: { correlationId?: string; payload: Record<string, unknown> }[] = [];
      eventBus.frames(FAILED).subscribe((f) => failures.push(f));

      await emit({
        channel: REQ,
        clientId: 'client-b',
        payload: { resourceId: 'r-2', options: OPTS }, correlationId: 'c-routed-fail' });

      // On the ENVELOPE, which is the only place owner-routing reads it.
      expect(failures[0]?.correlationId).toBe('c-routed-fail');
      // Identifying fields the failure's own contract requires ride in the
      // payload: `gather:resource-failed` is `{ resourceId } & CommandError`.
      expect(failures[0]?.payload.resourceId).toBe('r-2');
    });

    it('reaches the emitting client and nobody else', async () => {
      const owner = await subscribe(app, { clientId: 'client-owner', global: [FAILED] });
      const other = await subscribe(app, { clientId: 'client-other', global: [FAILED, 'test:event'] });
      await new Promise((r) => setTimeout(r, 20));

      setTimeout(() => {
        void emit({
          channel: REQ,
          clientId: 'client-owner',
          payload: { resourceId: 'r-3', options: OPTS }, correlationId: 'c-only-mine' });
        eventBus.emit('test:event' as never, { marker: 'alive' } as never);
      }, 10);

      expect(await readSSE(owner, (b) => b.includes('c-only-mine'))).toContain('c-only-mine');
      const otherBody = await readSSE(other, (b) => b.includes('alive'));
      expect(otherBody).not.toContain('c-only-mine');
    });

    // A broadcast reaching nobody is NORMAL — `job:started` with no UI
    // attached is the common case. The distinction is membership in
    // BUS_OPERATIONS, never a name pattern.
    it('stays silent for a broadcast that reaches nobody', async () => {
      const seen: unknown[] = [];
      for (const ch of ['gather:resource-failed', 'test:event']) {
        eventBus.on(ch as never).subscribe((v) => seen.push(v));
      }
      const before = seen.length;

      const res = await emit({ channel: 'beckon:focus', payload: { annotationId: 'ann-1' } });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toEqual({ subscribers: 0 });
      expect(seen.length).toBe(before); // nothing synthesized
    });

    it('stays silent when a request DID reach a subscriber', async () => {
      eventBus.on(REQ).subscribe(() => {}); // a handler is present
      const failures: unknown[] = [];
      eventBus.on(FAILED).subscribe((v) => failures.push(v));

      await emit({
        channel: REQ,
        clientId: 'client-c',
        payload: { resourceId: 'r-4', options: OPTS }, correlationId: 'c-answered' });

      expect(failures).toHaveLength(0);
    });

    // A request without a correlationId has no reply to fail: synthesizing one
    // would produce a frame the filter drops and nobody awaits.
    it('stays silent for a request emit with no correlationId', async () => {
      const failures: unknown[] = [];
      eventBus.on(FAILED).subscribe((v) => failures.push(v));
      await emit({ channel: REQ, payload: { resourceId: 'r-5', options: OPTS } });
      expect(failures).toHaveLength(0);
    });
  });

  // ── Gateway telemetry ─────────────────────────────────────────────────
  //
  // A counter that is wired but never incremented is the defect these pins
  // exist to prevent — nothing else in the stack would notice. Spans are not
  // pinned here: the repo tests no spans anywhere, and inventing a harness for
  // these four would be a precedent, not a pin.
  describe('telemetry', () => {
    const REQ = 'gather:resource-requested';
    const OPTS = { depth: 1, maxResources: 1, includeContent: false, includeSummary: false };

    it('counts an unanswerable request, labelled by channel', async () => {
      observed.unanswerable.mockClear();
      await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: REQ,
          clientId: 'client-t',
          correlationId: 'c-unans',
          payload: { resourceId: 'r-1', options: OPTS },
        }),
      });
      expect(observed.unanswerable).toHaveBeenCalledWith(REQ);
    });

    it('does not count a broadcast that reaches nobody', async () => {
      observed.unanswerable.mockClear();
      await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'beckon:focus', payload: { annotationId: 'ann-1' } }),
      });
      expect(observed.unanswerable).not.toHaveBeenCalled();
    });

    it('counts a resume gap, labelled by its reason', async () => {
      observed.resumeGap.mockClear();
      const res = await subscribe(app, {
        clientId: 'client-gap',
        global: ['test:event'],
        scoped: [{ scope: 'res-1', channels: ['test:event'], lastEventId: 'not-a-valid-id' }],
      });
      await readSSE(res, (b) => b.includes('resume-gap'));
      expect(observed.resumeGap).toHaveBeenCalled();
      // The label is a closed set, never a scope or an id — cardinality.
      expect(typeof observed.resumeGap.mock.calls[0]?.[0]).toBe('string');
      expect(observed.resumeGap.mock.calls[0]?.[0]).toMatch(/last-event-id|scope|replay/);
    });

    it('reports occupancy — claims, and the ceiling they are measured against', async () => {
      // The composition the ROUTE used, not a hand-built registry: occupancy
      // is what the gateway's boot feeds `semiont.bus.correlation.size`, and
      // a private registry would move without the served one moving.
      await subscribe(app, { clientId: 'client-occ', global: ['gather:resource-complete'] });
      const provider = () => compositionFor(eventBus).occupancy();
      expect(provider()).toMatchObject({ claims: 0 });
      // The ceiling rides the same snapshot so no reader restates it.
      expect(provider().claimsMax).toBeGreaterThan(0);

      await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: REQ,
          clientId: 'client-occ',
          correlationId: 'c-occ',
          payload: { resourceId: 'r-1', options: OPTS },
        }),
      });
      expect(provider().claims).toBeGreaterThan(0);
    });
  });

  describe('correlated-reply retention + pendingReplies replay', () => {
    it('replays a retained reply to a reconnecting subscriber that names its cid, with the deterministic id', async () => {
      // conn1 is the first subscription on this eventBus — it wires the
      // retention buffer. (The attach gate guarantees a real client has a
      // live connection before any busRequest emit, so first-subscribe
      // wiring is not a coverage hole.)
      const res1 = await subscribe(app, { clientId: 'client-lost', global: ['gather:resource-complete'] });
      expect(res1.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));

      // The request is claimed first: retention holds only claimed cids,
      // because "who may see this reply" is the question it answers. A
      // connected service takes it, so it is not fast-failed, and its answer
      // is the first — and so the retained — reply.
      const service = eventBus.on('gather:resource-requested').subscribe(() => {});
      await app.request('/bus/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'gather:resource-requested',
          clientId: 'client-lost',
          correlationId: 'cid-lost',
          payload: {
            resourceId: 'r-1',
            options: { depth: 1, maxResources: 1, includeContent: false, includeSummary: false },
          },
        }),
      });

      // The reply is published while the (conceptual) requester is
      // disconnected — nothing but retention holds it now.
      eventBus.emit('gather:resource-complete', {
        response: { ok: 1 },
      } as never, { correlationId: 'cid-lost' });
      service.unsubscribe();

      // The requester reconnects, naming its outstanding cid.
      const res2 = await subscribe(app, {
        clientId: 'client-lost',
        global: ['gather:resource-complete'],
        pendingReplies: ['cid-lost'],
      });
      const body = await readSSE(res2, (b) => b.includes('cid-lost'));
      expect(body).toContain('id: e-gather:resource-complete:cid-lost');
      expect(body).toContain('"correlationId":"cid-lost"');
    });

    it('an unknown cid replays nothing', async () => {
      await subscribe(app, { global: ['test:event'] }); // wire retention
      const res = await subscribe(app, { global: ['test:event'], pendingReplies: ['never-seen'] });
      setTimeout(() => eventBus.emit('test:event' as any, { marker: 1 }), 20);
      const body = await readSSE(res, (b) => b.includes('marker'));
      expect(body).not.toContain('never-seen');
    });

    it('rejects malformed pendingReplies with 400', async () => {
      expect((await subscribe(app, { global: ['test:event'], pendingReplies: 'nope' })).status).toBe(400);
      expect((await subscribe(app, { global: ['test:event'], pendingReplies: [1] })).status).toBe(400);
      const tooMany = Array.from({ length: 257 }, (_, i) => `c-${i}`);
      expect((await subscribe(app, { global: ['test:event'], pendingReplies: tooMany })).status).toBe(400);
    });
  });
});

describe('createCorrelationRegistry (unit — bounds with an injected clock)', () => {
  const OWNER = 'client-1';
  const DID = 'did:web:test:users:alice';

  // These pin the retention and claim bounds, plus the rule that only a
  // CLAIMED cid is retained at all. The ledger is fed by the composition's
  // plane tap; these unit tests feed `observe` directly, which is exactly what
  // the tap does. Each builds its ledger over an in-process plane, whose
  // table is the process's own.
  const setup = (opts: Parameters<typeof createCorrelationRegistry>[1] = {}) =>
    createCorrelationRegistry(createInProcessSignalPlane(new EventBus()), opts);

  it('retains a reply only for a claimed cid', async () => {
    const registry = setup({ now: () => 1 });
    await registry.claim('claimed', OWNER, DID);

    registry.observe('gather:resource-complete', { response: {} }, { correlationId: 'claimed' });
    registry.observe('gather:resource-complete', { response: {} }, { correlationId: 'unclaimed' });

    expect(await registry.lookupReply('claimed', OWNER, DID)).toBeDefined();
    // The in-process case: nobody claimed it, so nothing is held for it. Not a
    // lossy mode — the requester is the gateway and consumed it in-process.
    expect(await registry.lookupReply('unclaimed', OWNER, DID)).toBeUndefined();
    registry.dispose();
  });

  it('retains the FIRST reply to a cid — the one a connected client resolved on', async () => {
    // busRequest settles on the first reply for its cid and stops listening,
    // so replaying a later one would hand a reconnecting client an answer a
    // connected client never saw.
    const registry = setup({ now: () => 1 });
    await registry.claim('c1', OWNER, DID);
    registry.observe('gather:resource-failed', { message: 'first' }, { correlationId: 'c1' });
    registry.observe('gather:resource-complete', { response: { late: true } }, { correlationId: 'c1' });

    const retained = await registry.lookupReply('c1', OWNER, DID);
    expect(retained?.channel).toBe('gather:resource-failed');
    expect(retained?.payload).toEqual({ message: 'first' });
    registry.dispose();
  });

  it('refuses a lookup from a client that does not own the cid', async () => {
    const registry = setup({ now: () => 1 });
    await registry.claim('c1', OWNER, DID);
    registry.observe('gather:resource-complete', { response: {} }, { correlationId: 'c1' });

    expect(await registry.lookupReply('c1', 'client-2', DID)).toBeUndefined();
    expect(await registry.lookupReply('c1', OWNER, 'did:web:test:users:mallory')).toBeUndefined();
    expect(await registry.lookupReply('c1', OWNER, DID)).toBeDefined();
    registry.dispose();
  });

  it('expires a retained reply past the TTL while the claim survives', async () => {
    let clock = 1_000;
    const registry = setup({ ttlMs: 100, now: () => clock });
    await registry.claim('c1', OWNER, DID);
    registry.observe('gather:resource-complete', { response: {} }, { correlationId: 'c1' });
    expect(await registry.lookupReply('c1', OWNER, DID)).toBeDefined();

    clock += 101;
    expect(await registry.lookupReply('c1', OWNER, DID)).toBeUndefined();
    // Claims are cheap and long-lived; payloads are expensive and short-lived.
    expect(registry.owner('c1')).toBeDefined();
    registry.dispose();
  });


  it('refuses a duplicate claim and a per-client flood, without evicting', async () => {
    const registry = setup({ now: () => 1 });
    expect(await registry.claim('dup', OWNER, DID)).toBe('ok');
    expect(await registry.claim('dup', 'client-2', DID)).toBe('conflict');

    for (let i = 1; i < 256; i++) expect(await registry.claim(`f-${i}`, OWNER, DID)).toBe('ok');
    expect(await registry.claim('f-256', OWNER, DID)).toBe('at-capacity');
    expect(registry.owner('dup')).toBeDefined(); // nothing evicted to make room
    registry.dispose();
  });

  it('an answered claim frees its per-client capacity while staying retained', async () => {
    // The weaver's boot heal-storm: hundreds of sequential busRequests, each
    // answered within milliseconds. The cap counts UNANSWERED requests — its
    // own 429 message says so — so a client whose questions are all answered
    // must never be refused, no matter how many it has asked.
    const registry = setup({ now: () => 1 });
    for (let i = 0; i < 256; i++) {
      await registry.claim(`a-${i}`, OWNER, DID);
      registry.observe('gather:resource-complete', { response: {} }, { correlationId: `a-${i}` });
    }
    expect(await registry.claim('a-256', OWNER, DID)).toBe('ok');
    // Retention is untouched: answered claims still route and replay.
    expect(registry.owner('a-0')).toBeDefined();
    expect(await registry.lookupReply('a-0', OWNER, DID)).toBeDefined();
    registry.dispose();
  });

  it('sweeping an answered claim does not free its capacity twice', async () => {
    let clock = 1_000;
    const registry = setup({ claimTtlMs: 100, now: () => clock });
    await registry.claim('c1', OWNER, DID);
    registry.observe('gather:resource-complete', { response: {} }, { correlationId: 'c1' });
    clock += 200; // c1's claim expires; the sweep must not decrement again
    for (let i = 0; i < 256; i++) expect(await registry.claim(`u-${i}`, OWNER, DID)).toBe('ok');
    // A double-free would leave the counter at -1 and admit a 257th.
    expect(await registry.claim('u-256', OWNER, DID)).toBe('at-capacity');
    registry.dispose();
  });

  /**
   * Two replicas on one table whose watch has fallen behind: reads are
   * authoritative, the watch delivers nothing until `catchUp`. The other
   * replica's claims reach the table through its own `claim`, so no test
   * restates what a stored claim looks like.
   */
  function laggingFabric() {
    const tables = new Map<string, { entries: Map<string, string>; watchers: Array<(key: string, value: string) => void> }>();
    let reads = 0;
    const named = (name: string) => {
      let held = tables.get(name);
      if (!held) {
        held = { entries: new Map(), watchers: [] };
        tables.set(name, held);
      }
      return held;
    };
    const tableNamed = (name: string): SharedTable => {
      const { entries, watchers } = named(name);
      return {
        async create(key, value) {
          if (entries.has(key)) return false;
          entries.set(key, value);
          return true;
        },
        async read(key) {
          reads++;
          return entries.get(key);
        },
        async watch(onEntry) {
          watchers.push(onEntry);
          return { close() {} };
        },
      };
    };
    const replica = (): SignalPlane => ({ ...createInProcessSignalPlane(new EventBus()), table: async (name) => tableNamed(name) });
    /** Deliver what a table holds to its watchers — all tables, or one, in the order asked. */
    const catchUp = (...names: string[]) => {
      for (const name of names.length > 0 ? names : [...tables.keys()]) {
        const { entries, watchers } = named(name);
        for (const [key, value] of entries) for (const watcher of watchers) watcher(key, value);
      }
    };
    return { replica, reads: () => reads, catchUp };
  }

  it('after a restart, claims answered before it do not count against the client', async () => {
    const plane = createInProcessSignalPlane(new EventBus());
    const before = createCorrelationRegistry(plane);
    for (let i = 0; i < 256; i++) {
      await before.claim(`r-${i}`, OWNER, DID);
      before.observe('gather:resource-complete', { response: {} }, { correlationId: `r-${i}` });
    }
    // Answered-ness is recorded off the observe path.
    await new Promise((r) => setTimeout(r, 0));
    before.dispose();

    const after = createCorrelationRegistry(plane);
    await after.ready;
    expect(await after.claim('r-after', OWNER, DID), 'the client has no unanswered requests').toBe('ok');
    after.dispose();
  });

  it('after a restart, a claim answered before it does not warn when it expires; an unanswered one does', async () => {
    const warn = captureBusWarnings();
    let clock = 1_000;
    const plane = createInProcessSignalPlane(new EventBus());
    const opts = { claimTtlMs: 60_000, now: () => clock };
    const before = createCorrelationRegistry(plane, opts);
    await before.claim('answered-before', OWNER, DID);
    await before.claim('never-answered', OWNER, DID);
    before.observe('gather:resource-complete', { response: {} }, { correlationId: 'answered-before' });
    await new Promise((r) => setTimeout(r, 0));
    before.dispose();

    const after = createCorrelationRegistry(plane, opts);
    await after.ready;
    clock += 60_001;
    await after.claim('sweeps-first', OWNER, DID);

    const expired = warn.mock.calls
      .filter((c) => String(c[0]).includes('CLAIM-EXPIRED'))
      .map((c) => c[1])
      .filter(isObject)
      .map((fields) => fields.correlationId);
    expect(expired).toContain('never-answered');
    expect(expired).not.toContain('answered-before');
    after.dispose();
  });

  it('an answered marker that arrives before its claim makes the claim answered on adoption', async () => {
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const there = createCorrelationRegistry(fabric.replica());
    await there.claim('marker-first', OWNER, DID);
    there.observe('gather:resource-complete', { response: {} }, { correlationId: 'marker-first' });
    await new Promise((r) => setTimeout(r, 0));

    fabric.catchUp(LEDGER_TABLES.answered, LEDGER_TABLES.claims);
    expect(here.owner('marker-first'), 'adopted').toBeDefined();
    // Answered, so it holds none of the client's 256 slots.
    for (let i = 0; i < 256; i++) expect(await here.claim(`m-${i}`, OWNER, DID)).toBe('ok');
    here.dispose();
    there.dispose();
  });

  it("a replica's own answered marker coming back releases the client's slot once, not twice", async () => {
    const registry = setup();
    await registry.claim('echoed', OWNER, DID);
    for (let i = 1; i < 256; i++) await registry.claim(`e-${i}`, OWNER, DID);
    registry.observe('gather:resource-complete', { response: {} }, { correlationId: 'echoed' });
    // The marker is written, and this replica's own watch delivers it back.
    await new Promise((r) => setTimeout(r, 0));

    expect(await registry.claim('one-slot-free', OWNER, DID)).toBe('ok');
    expect(await registry.claim('no-slot-left', OWNER, DID), 'a double release would admit this').toBe('at-capacity');
    registry.dispose();
  });

  it('a claim this replica has not seen yet is read from the table, not refused', async () => {
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const there = createCorrelationRegistry(fabric.replica());
    await there.claim('elsewhere', OWNER, DID);
    expect(here.owner('elsewhere'), 'the watch has not delivered it').toBeUndefined();

    const delivered: string[] = [];
    here.gate(OWNER, DID).offer('gather:summary-result', 'elsewhere', () => delivered.push('reply'));
    await vi.waitFor(() => expect(delivered).toEqual(['reply']));
    expect(here.owner('elsewhere'), 'the read adopted it').toBeDefined();
    here.dispose();
    there.dispose();
  });

  it('every subscriber that missed shares one read, and only the owner is delivered', async () => {
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const there = createCorrelationRegistry(fabric.replica());
    await there.claim('shared', OWNER, DID);
    const readsBefore = fabric.reads();

    const delivered: string[] = [];
    here.gate(OWNER, DID).offer('gather:summary-result', 'shared', () => delivered.push(OWNER));
    here.gate('client-2', DID).offer('gather:summary-result', 'shared', () => delivered.push('client-2'));
    here.gate(OWNER, 'did:web:test:users:mallory').offer('gather:summary-result', 'shared', () => delivered.push('mallory'));
    await vi.waitFor(() => expect(delivered).toEqual([OWNER]));
    expect(fabric.reads() - readsBefore, 'one read for three subscribers').toBe(1);
    here.dispose();
    there.dispose();
  });

  it("a cid's later frames wait behind its read and arrive in order", async () => {
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const there = createCorrelationRegistry(fabric.replica());
    await there.claim('ordered', OWNER, DID);

    const delivered: string[] = [];
    const gate = here.gate(OWNER, DID);
    gate.offer('gather:summary-result', 'ordered', () => delivered.push('first'));
    gate.offer('gather:summary-result', 'ordered', () => delivered.push('second'));
    expect(delivered, 'neither overtakes the read').toEqual([]);
    await vi.waitFor(() => expect(delivered).toEqual(['first', 'second']));
    here.dispose();
    there.dispose();
  });

  it('a cid nobody claimed is dropped after the read, silently', async () => {
    const warn = captureBusWarnings();
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const delivered: string[] = [];
    here.gate(OWNER, DID).offer('gather:summary-result', 'in-process-request', () => delivered.push('reply'));
    await vi.waitFor(() => expect(fabric.reads()).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toEqual([]);
    // The structural in-process case: a gateway-internal request consumed its
    // own reply. A warn here would fire on every one of them.
    expect(warn.mock.calls).toEqual([]);
    here.dispose();
  });

  it('a gate closed while its read is pending delivers nothing', async () => {
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const there = createCorrelationRegistry(fabric.replica());
    await there.claim('gone', OWNER, DID);

    const delivered: string[] = [];
    const gate = here.gate(OWNER, DID);
    gate.offer('gather:summary-result', 'gone', () => delivered.push('reply'));
    gate.close();
    await vi.waitFor(() => expect(here.owner('gone')).toBeDefined());
    expect(delivered).toEqual([]);
    here.dispose();
    there.dispose();
  });

  it('a cid claimed on another replica is a conflict here, before this projection knows it', async () => {
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const there = createCorrelationRegistry(fabric.replica());
    expect(await there.claim('once', OWNER, DID)).toBe('ok');
    expect(here.owner('once')).toBeUndefined();
    expect(await here.claim('once', 'client-2', DID), 'the table refuses it, not the projection').toBe('conflict');
    here.dispose();
    there.dispose();
  });

  it('the watch catching up adopts a claim without a read', async () => {
    const fabric = laggingFabric();
    const here = createCorrelationRegistry(fabric.replica());
    const there = createCorrelationRegistry(fabric.replica());
    await there.claim('watched', OWNER, DID);
    fabric.catchUp();
    const readsBefore = fabric.reads();

    const delivered: string[] = [];
    here.gate(OWNER, DID).offer('gather:summary-result', 'watched', () => delivered.push('reply'));
    expect(delivered, 'decided synchronously, on the projection').toEqual(['reply']);
    expect(fabric.reads()).toBe(readsBefore);
    here.dispose();
    there.dispose();
  });

});
