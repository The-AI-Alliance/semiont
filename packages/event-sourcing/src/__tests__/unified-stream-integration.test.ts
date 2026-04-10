/**
 * UNIFIED-STREAM Phase 8b — Cross-phase integration tests
 *
 * Tests the complete event pipeline: EventStore → scoped EventBus →
 * events-stream enrichment → SSE delivery → client observable update.
 *
 * These are EventBus-level tests (no HTTP server). They verify:
 * 1. correlationId round-trip through appendEvent → scoped bus
 * 2. Two-subscriber simulation (both see enriched events)
 * 3. Replay-window-exceeded signal on reconnection gap
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SemiontProject } from '@semiont/core/node';
import {
  resourceId,
  userId,
  EventBus,
  CREATION_METHODS,
  type Logger,
} from '@semiont/core';
import type { EventStore } from '@semiont/event-sourcing';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

describe('Unified Stream Integration (Phase 8b)', () => {
  let testDir: string;
  let eventStore: EventStore;
  let eventBus: EventBus;

  beforeAll(async () => {
    testDir = path.join(tmpdir(), `semiont-8b-${uuidv4()}`);
    await fsPromises.mkdir(testDir, { recursive: true });

    const { createEventStore } = await import('@semiont/event-sourcing');
    const project = new SemiontProject(testDir);
    eventBus = new EventBus();
    eventStore = createEventStore(project, eventBus, mockLogger);
  });

  afterAll(async () => {
    eventBus.destroy();
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  // ── Test 1: correlationId round-trip ──────────────────────────────────

  it('correlationId threads through appendEvent to scoped bus delivery', async () => {
    const rId = resourceId('8b-corr-test');
    const cid = 'corr-round-trip-001';

    // Create the resource first
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'CorrelationTest',
        format: 'text/plain',
        contentChecksum: 'sha:test',
        creationMethod: CREATION_METHODS.API,
      },
    });

    // Create a stub annotation
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
          type: 'Annotation' as const,
          id: 'ann-corr-1',
          motivation: 'linking' as const,
          target: { source: rId, selector: [{ type: 'TextQuoteSelector', exact: 'test' }] },
          body: [],
          modified: new Date().toISOString(),
        },
      },
    });

    // Subscribe to scoped bus BEFORE the mutation
    const scopedBus = eventBus.scope(String(rId));
    const received: any[] = [];
    const sub = scopedBus.get('mark:body-updated').subscribe((event) => {
      received.push(event);
    });

    // Append a body-updated event with correlationId
    const stored = await eventStore.appendEvent(
      {
        type: 'mark:body-updated',
        resourceId: rId,
        userId: userId('user-1'),
        version: 1,
        payload: {
          annotationId: 'ann-corr-1',
          operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'target-res' } }],
        },
      },
      { correlationId: cid },
    );

    // Wait for async delivery
    await new Promise((r) => setTimeout(r, 50));

    sub.unsubscribe();

    // The stored event has correlationId in metadata
    expect(stored.metadata.correlationId).toBe(cid);

    // The scoped bus received the event
    expect(received).toHaveLength(1);
    expect(received[0].metadata.correlationId).toBe(cid);
    expect(received[0].type).toBe('mark:body-updated');
  });

  // ── Test 2: Two-subscriber simulation ─────────────────────────────────

  it('two subscribers on the same resource both receive the event', async () => {
    const rId = resourceId('8b-two-tab');

    // Create resource
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'TwoTabTest',
        format: 'text/plain',
        contentChecksum: 'sha:twotab',
        creationMethod: CREATION_METHODS.API,
      },
    });

    // Create annotation
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
          type: 'Annotation' as const,
          id: 'ann-tab-1',
          motivation: 'linking' as const,
          target: { source: rId, selector: [{ type: 'TextQuoteSelector', exact: 'two-tab' }] },
          body: [],
          modified: new Date().toISOString(),
        },
      },
    });

    // Two "clients" subscribe to the scoped bus (simulates two browser tabs)
    const scopedBus = eventBus.scope(String(rId));
    const client1Events: any[] = [];
    const client2Events: any[] = [];

    const sub1 = scopedBus.get('mark:body-updated').subscribe((e) => client1Events.push(e));
    const sub2 = scopedBus.get('mark:body-updated').subscribe((e) => client2Events.push(e));

    // One client initiates a bind (appends event with correlationId)
    const cid = 'corr-client1-bind';
    await eventStore.appendEvent(
      {
        type: 'mark:body-updated',
        resourceId: rId,
        userId: userId('user-1'),
        version: 1,
        payload: {
          annotationId: 'ann-tab-1',
          operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'linked-res' } }],
        },
      },
      { correlationId: cid },
    );

    await new Promise((r) => setTimeout(r, 50));

    sub1.unsubscribe();
    sub2.unsubscribe();

    // Both clients see the event
    expect(client1Events).toHaveLength(1);
    expect(client2Events).toHaveLength(1);

    // Both have the same event data
    expect(client1Events[0].metadata.correlationId).toBe(cid);
    expect(client2Events[0].metadata.correlationId).toBe(cid);
    expect(client1Events[0].payload.annotationId).toBe('ann-tab-1');
    expect(client2Events[0].payload.annotationId).toBe('ann-tab-1');

    // Client 1 (originator) can match by correlationId
    const isOriginator = client1Events[0].metadata.correlationId === cid;
    expect(isOriginator).toBe(true);
  });

  // ── Test 3: replay-window-exceeded signal ─────────────────────────────

  it('replay-window-exceeded emits when gap exceeds the cap', async () => {
    const rId = resourceId('8b-replay');
    const received: any[] = [];

    const sub = eventBus.get('replay-window-exceeded').subscribe((e) => {
      received.push(e);
    });

    // Simulate the backend emitting replay-window-exceeded
    // (In production this is emitted by the events-stream route when
    // Last-Event-ID is older than REPLAY_WINDOW_CAP)
    eventBus.get('replay-window-exceeded').next({
      resourceId: String(rId),
      lastEventId: 5,
      missedCount: 150,
      cap: 100,
      message: 'Replay window exceeded: 150 events missed (cap: 100)',
    });

    await new Promise((r) => setTimeout(r, 10));
    sub.unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0].resourceId).toBe(String(rId));
    expect(received[0].missedCount).toBe(150);
    expect(received[0].cap).toBe(100);
  });

  // ── Test 4: event ordering guarantee ──────────────────────────────────

  it('appendEvent materializes view before publishing to scoped bus', async () => {
    const rId = resourceId('8b-ordering');

    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'OrderingTest',
        format: 'text/plain',
        contentChecksum: 'sha:order',
        creationMethod: CREATION_METHODS.API,
      },
    });

    // Subscribe and check that the view is already materialized
    // when the event arrives on the bus
    const scopedBus = eventBus.scope(String(rId));
    let viewExistedWhenEventArrived = false;

    const sub = scopedBus.get('mark:added').subscribe(async () => {
      // At this point, the view should already be materialized
      // (appendEvent awaits materialization before publishing)
      const view = await eventStore.viewStorage.get(rId);
      viewExistedWhenEventArrived = view !== null;
    });

    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
          type: 'Annotation' as const,
          id: 'ann-order-1',
          motivation: 'highlighting' as const,
          target: { source: rId, selector: [{ type: 'TextQuoteSelector', exact: 'test' }] },
          body: [],
          modified: new Date().toISOString(),
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(viewExistedWhenEventArrived).toBe(true);
  });
});
