/**
 * Tests for `gather.resource()` — whole-resource LLM context, a request/reply
 * over `gather:resource-requested` → `gather:resource-complete`/`-failed`
 * (no progress events, so a Promise via busRequest, not a StreamObservable).
 *
 * The gateway route (`gatherer.ts` handleResourceGather) answers on the wire contract
 * (GatherResourceRequest/Complete, carrying a unified GatheredContext);
 * this exercises the SDK method that calls it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { EventMap } from '@semiont/core';
import { GatherNamespace } from '../namespaces/gather';
import { inMemoryTransport } from './helpers/in-memory-transport';
import { resourceContextFor } from './fixtures/gathered-context';

function makeTransport() {
  const bus = new EventBus();
  let lastChannel: string | null = null;
  let lastPayload: Record<string, unknown> | null = null;
  let lastCorrelationId: string | undefined;
  const transport = inMemoryTransport({
    bus,
    onEmit: (channel, payload, envelope) => {
      lastChannel = channel as string;
      lastPayload = payload as Record<string, unknown>;
      lastCorrelationId = envelope?.correlationId;
    },
  });
  return {
    transport,
    // Replies are pushed through the SAME typed bus the transport streams
    // from, so a fixture that is not the channel's declared payload is a
    // compile error rather than something a cast on the transport hides.
    // A push verb, not a handle: `on` is read-only by design, and the write
    // path is `emit`.
    push: <K extends keyof EventMap>(channel: K, payload: EventMap[K], correlationId?: string) =>
      bus.emit(channel, payload, { correlationId }),
    getLastChannel: () => lastChannel,
    getLastPayload: () => lastPayload,
    getLastCorrelationId: () => lastCorrelationId,
  };
}

describe('gather.resource', () => {
  let bus: EventBus;
  afterEach(() => bus?.destroy());

  function makeGather() {
    bus = new EventBus();
    const t = makeTransport();
    return { gather: new GatherNamespace(t.transport, bus), ...t };
  }

  it('emits gather:resource-requested with defaulted options and resolves the response', async () => {
    const { gather, push, getLastChannel, getLastPayload, getLastCorrelationId } = makeGather();
    const rid = makeResourceId('r1');

    const promise = gather.resource(rid);
    await Promise.resolve(); // let busRequest subscribe + emit

    expect(getLastChannel()).toBe('gather:resource-requested');
    const payload = getLastPayload()!;
    expect(payload).toMatchObject({
      resourceId: rid,
      options: { depth: 2, maxResources: 10, includeContent: true, includeSummary: false },
    });
    const cid = getLastCorrelationId()!;
    expect(typeof cid).toBe('string');

    // gather:resource-complete carries a unified GatheredContext (focus.kind:'resource').
    const response = resourceContextFor(rid);
    push('gather:resource-complete', { resourceId: rid, response }, cid);

    expect(await promise).toEqual(response);
  });

  it('passes explicit options through', async () => {
    const { gather, getLastPayload } = makeGather();
    void gather.resource(makeResourceId('r2'), {
      depth: 1,
      maxResources: 5,
      includeContent: false,
      includeSummary: true,
    });
    await Promise.resolve();
    expect(getLastPayload()).toMatchObject({
      options: { depth: 1, maxResources: 5, includeContent: false, includeSummary: true },
    });
  });

  it('rejects when gather:resource-failed arrives', async () => {
    const { gather, push, getLastCorrelationId } = makeGather();
    const captured = gather.resource(makeResourceId('r3')).catch((e) => e);
    await Promise.resolve();
    const cid = getLastCorrelationId()!;

    push('gather:resource-failed', {
      resourceId: makeResourceId('r3'),
      message: 'graph traversal failed',
      // No `code`: the contract declares only 'peer-unavailable' | 'not-found',
      // and the wire never carries 'gather.failed'. An absent code is exactly
      // the case the SDK maps to `bus.rejected`, which is what this asserts.
    }, cid);

    const err = await captured;
    expect(err).toMatchObject({ code: 'bus.rejected', message: 'graph traversal failed' });
  });
});
