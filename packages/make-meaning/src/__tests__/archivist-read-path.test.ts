/**
 * EXTRACT-ARCHIVIST P2a — the D1 sequence-ranged read path.
 *
 * This extraction takes the event store out of the gateway's process, which
 * breaks `/bus/subscribe`'s `Last-Event-ID` replay (bus.ts reads the log
 * in-process). D1 (settled 2026-08-27): a dedicated read path on the
 * Archivist, one narrow call — the events for one resource from one
 * sequence — mirroring `queryEvents(rId, { fromSequence })` exactly.
 *
 * The reconnect gate lives here because the failure is SILENT: a gateway
 * that cannot replay degrades to a gap event, invisible to any typecheck.
 * This test asserts replay-not-gap against a real event log.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'net';
import { promises as fs } from 'fs';
import * as path from 'path';
import { EventBus, resourceId, userId, type Logger, type ResourceId, type StoredEvent } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore, calculateChecksum } from '@semiont/content';
import type { StoredResource } from '@semiont/core';
import { createServer, type Server } from 'http';
import type { IssuerVerifier } from '@semiont/core/identity';
import { createArchivistServer } from '../archivist-read-path';
import { archivistContentReads } from '@semiont/content';
import type { ArchivistAddressConfig } from '@semiont/core/node';
import { createTestProject, type TestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

/**
 * A stub verifier standing in for the real one. The Archivist's contract is
 * "a token the trusted issuer signed, carrying the service role"; exercising
 * jose's signature checking here would test jose, not the Archivist.
 * `identity/issuer.test.ts` in core owns that.
 */
const SERVICE_TOKEN = 'a-service-account-token';
const stubVerifier = {
  issuer: 'https://issuer.test',
  audience: 'https://example.github.io/kb',
  verify: async (token: string) => {
    if (token !== SERVICE_TOKEN) throw new Error('bad signature');
    return { sub: 'service-account-semiont-gateway', roles: ['semiont-service'] };
  },
} as unknown as IssuerVerifier;

describe('Archivist D1 read path (EXTRACT-ARCHIVIST P2a)', () => {
  let tp: TestProject;
  let eventBus: EventBus;
  let eventStore: EventStore;
  let rid: ResourceId;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    tp = await createTestProject('archivist-read-path');
    eventBus = new EventBus();
    eventStore = createEventStore(tp.project, eventBus, mockLogger);

    rid = resourceId('res-d1');
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: rid,
      userId: userId('did:web:test:users:user-d1'),
      version: 1,
      payload: { name: 'Replayed', format: 'text/plain', contentChecksum: 'h1' },
    });
    for (const entityType of ['A', 'B', 'C', 'D']) {
      await eventStore.appendEvent({
        type: 'mark:entity-tag-added',
        resourceId: rid,
        userId: userId('did:web:test:users:user-d1'),
        version: 1,
        payload: { entityType },
      });
    }

    const server = createArchivistServer({
      events: eventStore.log,
      content: new WorkingTreeStore(tp.project, mockLogger),
      views: eventStore.viewStorage,
      verifier: stubVerifier,
      health: () => ({ status: 'ok' }),
      logger: mockLogger,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  afterEach(async () => {
    await close();
    eventBus.destroy();
    await tp.teardown();
  });

  it('replays events from a sequence — a reconnecting subscriber gets replay, not a gap', async () => {
    // The gateway's reconnect shape: a client held sequence 3, so the
    // gateway asks from 3 + 1 (bus.ts passes fromSequence: parsed.sequence + 1).
    const res = await fetch(`${baseUrl}/events/${encodeURIComponent(String(rid))}?fromSequence=4`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const { events } = await res.json() as { events: StoredEvent[] };
    expect(events).toHaveLength(2);
    expect(events[0]!.metadata.sequenceNumber).toBe(4);
    expect(events[1]!.metadata.sequenceNumber).toBe(5);
    expect(events.map((e) => e.type)).toEqual(['mark:entity-tag-added', 'mark:entity-tag-added']);
  });

  it('fromSequence past the head replays nothing — an empty page, still not an error', async () => {
    const res = await fetch(`${baseUrl}/events/${encodeURIComponent(String(rid))}?fromSequence=99`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const { events } = await res.json() as { events: StoredEvent[] };
    expect(events).toHaveLength(0);
  });

  it('refuses an unauthenticated read', async () => {
    const res = await fetch(`${baseUrl}/events/${encodeURIComponent(String(rid))}?fromSequence=1`);
    expect(res.status).toBe(401);
  });

  it('refuses a read without fromSequence — the seam is sequence-ranged, never whole-log', async () => {
    const res = await fetch(`${baseUrl}/events/${encodeURIComponent(String(rid))}`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('serves no branch route: the knowledge base describes itself over the bus', async () => {
    const res = await fetch(`${baseUrl}/kb/branch`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('serves /health without auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  /**
   * SINGLE-KB-MOUNT P2 — the Archivist accepts bytes (D1 reverses GATEWAY.md
   * D4a). The gateway will stream upload bodies here instead of writing the
   * shared mount itself; the event contract is untouched — the Stower still
   * `register`s and does the one `git add` on event apply, which is why the
   * write below is `noGit` and emits nothing.
   */
  describe('PUT /content/:storageUri (SINGLE-KB-MOUNT P2)', () => {
    const BODY = 'hello archivist';
    const URI = 'file://docs/note.md';
    const put = (uri: string, body: string, opts: { auth?: string; checksum?: string } = {}) =>
      fetch(`${baseUrl}/content/${encodeURIComponent(uri)}${opts.checksum ? `?checksum=${opts.checksum}` : ''}`, {
        method: 'PUT',
        body,
        ...(opts.auth !== undefined ? { headers: { authorization: opts.auth } } : {}),
      });

    it('writes the bytes and returns the stored record', async () => {
      const res = await put(URI, BODY, { auth: `Bearer ${SERVICE_TOKEN}` });
      expect(res.status).toBe(200);

      const stored = await res.json() as StoredResource;
      expect(stored.storageUri).toBe(URI);
      expect(stored.checksum).toBe(calculateChecksum(BODY));
      expect(stored.byteSize).toBe(Buffer.byteLength(BODY));

      // On disk where the Stower's `register` will find it on event apply.
      const onDisk = await fs.readFile(path.join(tp.project.root, 'docs/note.md'), 'utf8');
      expect(onDisk).toBe(BODY);
    });

    it('accepts a matching checksum', async () => {
      const res = await put(URI, BODY, { auth: `Bearer ${SERVICE_TOKEN}`, checksum: calculateChecksum(BODY) });
      expect(res.status).toBe(200);
    });

    it('rejects a disagreeing checksum before anything is written', async () => {
      const res = await put('file://docs/evil.md', BODY, {
        auth: `Bearer ${SERVICE_TOKEN}`,
        checksum: calculateChecksum('different bytes'),
      });
      expect(res.status).toBe(409);

      // "Before anything is written" is the load-bearing half: a rejected
      // body must leave no file for the Stower's register to trip over.
      await expect(fs.access(path.join(tp.project.root, 'docs/evil.md'))).rejects.toThrow();
    });

    it('refuses an unauthenticated write', async () => {
      const res = await put(URI, BODY);
      expect(res.status).toBe(401);
      await expect(fs.access(path.join(tp.project.root, 'docs/note.md'))).rejects.toThrow();
    });

    it('refuses to serve open when no verifier is configured — 401, never default-open', async () => {
      const secretless = createArchivistServer({
        events: eventStore.log,
        content: new WorkingTreeStore(tp.project, mockLogger),
        views: eventStore.viewStorage,
        verifier: null,
        health: () => ({ status: 'ok' }),
        logger: mockLogger,
      });
      await new Promise<void>((resolve) => secretless.listen(0, resolve));
      const port = (secretless.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/content/${encodeURIComponent(URI)}`, {
          method: 'PUT',
          body: BODY,
        });
        // 401, not a distinct status: an unverified caller does not learn
        // whether this deployment is configured.
        expect(res.status).toBe(401);
      } finally {
        await new Promise<void>((resolve, reject) => secretless.close((e) => (e ? reject(e) : resolve())));
      }
    });

    it('refuses an empty storage URI', async () => {
      const res = await fetch(`${baseUrl}/content/`, {
        method: 'PUT',
        body: BODY,
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      expect(res.status).toBe(400);
    });
  });

  /**
   * SINGLE-KB-MOUNT P3 — the Archivist serves bytes. Addressed by resourceId,
   * because that is the key the one resolution takes and the key
   * `IContentTransport.getBinary` will bring in P4; the caller never converts
   * to a tree address only to have this side convert back.
   */
  describe('GET /resources/:id/content (SINGLE-KB-MOUNT P3)', () => {
    const CONTENT = '# Served by the Archivist\n';
    const CONTENT_URI = 'file://docs/served.md';
    const SERVED = resourceId('res-served');

    beforeEach(async () => {
      await new WorkingTreeStore(tp.project, mockLogger).store(Buffer.from(CONTENT), CONTENT_URI, { noGit: true });
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: SERVED,
        userId: userId('did:web:test:users:user-d1'),
        version: 1,
        payload: { name: 'Served', format: 'text/markdown', contentChecksum: 'h2', storageUri: CONTENT_URI },
      });
    });

    // `null` means "send no Authorization header" — deliberately not
    // `undefined`, which would silently trigger the default and test nothing.
    const get = (id: string, auth: string | null = `Bearer ${SERVICE_TOKEN}`) =>
      fetch(`${baseUrl}/resources/${encodeURIComponent(id)}/content`, {
        ...(auth !== null ? { headers: { authorization: auth } } : {}),
      });

    it('serves the stored bytes with the stored media type verbatim', async () => {
      const res = await get(String(SERVED));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/markdown');
      expect(await res.text()).toBe(CONTENT);
    });

    it('distinguishes an unknown resource from one with no representation', async () => {
      expect((await get('res-nobody')).status).toBe(404);

      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId('res-bodiless'),
        userId: userId('did:web:test:users:user-d1'),
        version: 1,
        payload: { name: 'Bodiless', format: 'text/plain', contentChecksum: 'h3' },
      });
      const bodiless = await get('res-bodiless');
      expect(bodiless.status).toBe(404);

      // The gateway maps these to two different client-visible messages, so
      // the wire must carry which case it is.
      const unknownBody = await (await get('res-nobody')).json() as { reason?: string };
      const bodilessBody = await bodiless.json() as { reason?: string };
      expect(unknownBody.reason).toBe('resource');
      expect(bodilessBody.reason).toBe('representation');
    });

    it('refuses an unauthenticated read', async () => {
      expect((await get(String(SERVED), null)).status).toBe(401);
    });

    it('refuses to serve open when no verifier is configured', async () => {
      const secretless = createArchivistServer({
        events: eventStore.log,
        content: new WorkingTreeStore(tp.project, mockLogger),
        views: eventStore.viewStorage,
        verifier: null,
        health: () => ({ status: 'ok' }),
        logger: mockLogger,
      });
      await new Promise<void>((resolve) => secretless.listen(0, resolve));
      const port = (secretless.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/resources/${encodeURIComponent(String(SERVED))}/content`);
        // 401, not a distinct status: configuration state is not an
        // unverified caller's business.
        expect(res.status).toBe(401);
      } finally {
        await new Promise<void>((resolve, reject) => secretless.close((e) => (e ? reject(e) : resolve())));
      }
    });

    // The CLIENT of the route above (SINGLE-KB-MOUNT P4). Driven against the
    // live server rather than a mock: this pair is the whole point of the two
    // halves living in one package, and a mock would let either side drift.
    describe('archivistContentReads (SINGLE-KB-MOUNT P4)', () => {
      /**
       * A minimal issuer: discovery and a token endpoint that hands out the
       * one token the stub verifier accepts. Stood up for real rather than
       * mocked, for the same reason the Archivist is: this test exists to
       * prove the client and the server agree, and a mock on either side
       * would let them drift apart unnoticed.
       */
      let issuer: Server;
      let issuerUrl: string;

      beforeEach(async () => {
        issuer = createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (req.url?.includes('/.well-known/openid-configuration')) {
            res.end(JSON.stringify({ issuer: issuerUrl, token_endpoint: `${issuerUrl}/token` }));
            return;
          }
          res.end(JSON.stringify({ access_token: SERVICE_TOKEN, expires_in: 300 }));
        });
        await new Promise<void>((resolve) => issuer.listen(0, resolve));
        issuerUrl = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
        vi.stubEnv('SEMIONT_OIDC_CLIENT_ID', 'semiont-librarian');
        vi.stubEnv('SEMIONT_OIDC_CLIENT_SECRET', 'a-client-secret');
      });

      afterEach(async () => {
        vi.unstubAllEnvs();
        await new Promise<void>((resolve, reject) => issuer.close((e) => (e ? reject(e) : resolve())));
      });

      // A credential the test supplies itself — which it could not do while
      // `archivistAddress` read one out of `process.env`. Built on demand
      // because `issuerUrl` is assigned by a hook, not at describe time.
      const testCredential = () => ({ issuer: issuerUrl, clientId: 'semiont-test', clientSecret: 'test-secret' });

      const addressOf = (url: string): ArchivistAddressConfig => {
        const { hostname, port } = new URL(url);
        return { services: { archivist: { host: hostname, port: Number(port) } } };
      };

      it('reads the bytes and the stored media type — the same shape the in-process face returns', async () => {
        const { data, contentType } = await archivistContentReads(addressOf(baseUrl), testCredential()).getBinary(SERVED);
        expect(Buffer.from(data).toString('utf-8')).toBe(CONTENT);
        expect(contentType).toBe('text/markdown');
      });

      it('surfaces a miss as RepresentationMissing, carrying which half failed', async () => {
        const reads = archivistContentReads(addressOf(baseUrl), testCredential());

        // Same error type the working-tree face throws for the same fact: a
        // caller cannot tell whether the bytes were a hop away.
        await expect(reads.getBinary(resourceId('res-nobody'))).rejects.toMatchObject({
          name: 'RepresentationMissing',
          reason: 'resource',
        });

        await eventStore.appendEvent({
          type: 'yield:created',
          resourceId: resourceId('res-clientless'),
          userId: userId('did:web:test:users:user-d1'),
          version: 1,
          payload: { name: 'Bodiless', format: 'text/plain', contentChecksum: 'h4' },
        });
        await expect(reads.getBinary(resourceId('res-clientless'))).rejects.toMatchObject({
          reason: 'representation',
        });
      });

      it('refuses at construction when the address is missing', () => {
        // Boot-time, not first-read: a Smelter with no Archivist address must
        // die while an operator is watching, not fail every resource quietly.
        expect(() => archivistContentReads({}, testCredential())).toThrow(/services\.archivist\.host/);
      });

      it('takes the credential from its caller, so a test can supply its own', () => {
        // This is the property that was missing. The function used to read
        // SEMIONT_OIDC_CLIENT_ID/_SECRET out of `process.env` mid-call, so a
        // caller could neither supply a credential, stub one, nor hold two —
        // and a narrowed config satisfied the type carrying none of what the
        // function needed, which is exactly how the Librarian shipped broken.
        const reads = archivistContentReads(addressOf(baseUrl), {
          issuer: issuerUrl, clientId: 'a-different-client', clientSecret: 'a-different-secret',
        });
        expect(reads.getBinary).toBeTypeOf('function');
      });
    });
  });
});
