/**
 * FlowEngine.bind() tests
 *
 * After the UNIFIED-STREAM migration, bind is a plain POST. The bind flow
 * subscribes to bind:update-body, calls http.bindAnnotation, and lets the
 * events-stream deliver the mark:body-updated enriched event to all clients.
 * No per-operation SSE stream, no bind:finished/bind:failed channels.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import { FlowEngine } from '../flows';
import type { SSEClient } from '../sse/index';
import type { SemiontApiClient } from '../client';

describe('FlowEngine.bind()', () => {
  let eventBus: EventBus;
  let sse: SSEClient;
  let bindAnnotation: ReturnType<typeof vi.fn>;
  let http: SemiontApiClient;
  let engine: FlowEngine;

  const RID = resourceId('res-1');
  const AID = annotationId('ann-1');

  beforeEach(() => {
    eventBus = new EventBus();

    sse = {
      matchSearch: vi.fn(),
    } as unknown as SSEClient;

    bindAnnotation = vi.fn().mockResolvedValue({ correlationId: 'corr-1' });

    http = {
      bindAnnotation,
      stores: {
        annotations: { updateInPlace: vi.fn() },
      },
    } as unknown as SemiontApiClient;

    engine = new FlowEngine(eventBus, sse, http);
  });

  it('calls http.bindAnnotation with the operations from bind:update-body', async () => {
    const sub = engine.bind(RID, () => undefined);

    eventBus.get('bind:update-body').next({
      correlationId: 'corr-test',
      annotationId: AID,
      resourceId: 'res-1' as any,
      operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'res-2' } }] as any,
    });

    // Allow the async subscriber to run
    await new Promise((r) => setTimeout(r, 0));

    expect(bindAnnotation).toHaveBeenCalledTimes(1);
    expect(bindAnnotation).toHaveBeenCalledWith(
      RID,
      AID,
      { operations: expect.arrayContaining([expect.objectContaining({ op: 'add' })]) },
      { auth: undefined },
    );

    sub.unsubscribe();
  });

  it('emits bind:body-update-failed on HTTP error', async () => {
    bindAnnotation.mockRejectedValueOnce(new Error('500 Internal Server Error'));

    const failures: any[] = [];
    eventBus.get('bind:body-update-failed').subscribe((e) => failures.push(e));

    const sub = engine.bind(RID, () => undefined);

    eventBus.get('bind:update-body').next({
      correlationId: 'corr-test',
      annotationId: AID,
      resourceId: 'res-1' as any,
      operations: [] as any,
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain('500');

    sub.unsubscribe();
  });

  it('does not call sse.bindAnnotation (SSE stream is gone)', async () => {
    const sub = engine.bind(RID, () => undefined);

    eventBus.get('bind:update-body').next({
      correlationId: 'corr-test',
      annotationId: AID,
      resourceId: 'res-1' as any,
      operations: [] as any,
    });

    await new Promise((r) => setTimeout(r, 0));

    // The SSE client should have no bindAnnotation method called
    expect((sse as any).bindAnnotation).toBeUndefined();

    sub.unsubscribe();
  });
});
