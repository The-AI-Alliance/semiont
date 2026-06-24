/**
 * Tests for `gather.resource()` — whole-resource LLM context, a request/reply
 * over `gather:resource-requested` → `gather:resource-complete`/`-failed`
 * (no progress events, so a Promise via busRequest, not a StreamObservable).
 *
 * The backend route (`gatherer.ts` handleResourceGather) and the wire contract
 * (GatherResourceRequest/Complete, ResourceLLMContextResponse) already exist;
 * this exercises the SDK method that was previously a throwing stub. See the
 * my-chat SDK-FRICTION-LOG B1.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { ITransport, EventMap } from '@semiont/core';
import { GatherNamespace } from '../namespaces/gather';

function makeTransport() {
  const subjects: Record<string, Subject<unknown>> = {};
  const subjectFor = (ch: string) => (subjects[ch] ??= new Subject<unknown>());
  let lastChannel: string | null = null;
  let lastPayload: Record<string, unknown> | null = null;
  const transport = {
    baseUrl: 'http://test',
    emit: vi.fn(async (channel: keyof EventMap, payload: EventMap[keyof EventMap]) => {
      lastChannel = channel as string;
      lastPayload = payload as Record<string, unknown>;
    }),
    stream: vi.fn(
      (channel: keyof EventMap) =>
        subjectFor(channel as string).asObservable() as unknown as Observable<EventMap[keyof EventMap]>,
    ),
    subscribeToResource: () => () => {},
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  } as unknown as ITransport;
  return {
    transport,
    subjectFor,
    getLastChannel: () => lastChannel,
    getLastPayload: () => lastPayload,
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
    const { gather, subjectFor, getLastChannel, getLastPayload } = makeGather();
    const rid = makeResourceId('r1');

    const promise = gather.resource(rid);
    await Promise.resolve(); // let busRequest subscribe + emit

    expect(getLastChannel()).toBe('gather:resource-requested');
    const payload = getLastPayload()!;
    expect(payload).toMatchObject({
      resourceId: rid,
      options: { depth: 2, maxResources: 10, includeContent: true, includeSummary: false },
    });
    const cid = payload.correlationId as string;
    expect(typeof cid).toBe('string');

    const response = { mainResource: { id: rid }, relatedResources: [], annotations: [] };
    subjectFor('gather:resource-complete').next({ correlationId: cid, resourceId: rid, response });

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
    const { gather, subjectFor, getLastPayload } = makeGather();
    const captured = gather.resource(makeResourceId('r3')).catch((e) => e);
    await Promise.resolve();
    const cid = getLastPayload()!.correlationId as string;

    subjectFor('gather:resource-failed').next({
      correlationId: cid,
      resourceId: 'r3',
      message: 'graph traversal failed',
      code: 'gather.failed',
    });

    const err = await captured;
    expect(err).toMatchObject({ code: 'bus.rejected', message: 'graph traversal failed' });
  });
});
