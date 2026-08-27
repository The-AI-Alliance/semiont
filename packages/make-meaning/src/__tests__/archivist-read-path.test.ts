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
import { EventBus, resourceId, userId, type Logger, type ResourceId, type StoredEvent } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { createArchivistServer } from '../archivist-read-path';
import { createTestProject, type TestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const SECRET = 'test-worker-secret';

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
      userId: userId('user-d1'),
      version: 1,
      payload: { name: 'Replayed', format: 'text/plain', contentChecksum: 'h1' },
    });
    for (const entityType of ['A', 'B', 'C', 'D']) {
      await eventStore.appendEvent({
        type: 'mark:entity-tag-added',
        resourceId: rid,
        userId: userId('user-d1'),
        version: 1,
        payload: { entityType },
      });
    }

    const server = createArchivistServer({
      events: eventStore.log,
      workerSecret: SECRET,
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
      headers: { authorization: `Bearer ${SECRET}` },
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
      headers: { authorization: `Bearer ${SECRET}` },
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
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(400);
  });

  it('serves /health without auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
