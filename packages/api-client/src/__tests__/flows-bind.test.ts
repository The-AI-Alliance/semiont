/**
 * FlowEngine.bind() tests
 *
 * Focus: the local-mutation path. When bind:finished arrives, the bind flow
 * must call AnnotationStore.updateInPlace with the new annotation, and must
 * NOT trigger an HTTP refetch. This is the contract that makes the link icon
 * flip independent of the long-lived events-stream side channel.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import type { components } from '@semiont/core';
import { FlowEngine } from '../flows';
import type { SSEClient } from '../sse/index';
import type { SemiontApiClient } from '../client';

type Annotation = components['schemas']['Annotation'];

function makeAnnotation(id: string, source?: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id,
    motivation: 'linking',
    created: '2026-01-01T00:00:00Z',
    target: { source: 'res-1' },
    body: source
      ? [{ type: 'SpecificResource', source, purpose: 'linking' }]
      : [],
  } as Annotation;
}

describe('FlowEngine.bind()', () => {
  let eventBus: EventBus;
  let sse: SSEClient;
  let updateInPlace: ReturnType<typeof vi.fn>;
  let browseAnnotations: ReturnType<typeof vi.fn>;
  let http: SemiontApiClient;
  let engine: FlowEngine;

  const RID = resourceId('res-1');
  const AID = annotationId('ann-1');

  beforeEach(() => {
    eventBus = new EventBus();

    sse = {
      bindAnnotation: vi.fn(),
      matchSearch: vi.fn(),
    } as unknown as SSEClient;

    updateInPlace = vi.fn();
    browseAnnotations = vi.fn();

    http = {
      stores: {
        annotations: { updateInPlace },
      },
      browseAnnotations,
    } as unknown as SemiontApiClient;

    engine = new FlowEngine(eventBus, sse, http);
  });

  it('bind:finished writes through to AnnotationStore in-place, no refetch', () => {
    const sub = engine.bind(RID, () => undefined);

    // Trigger the bind: this registers the finishedSub for AID
    eventBus.get('bind:update-body').next({
      annotationId: AID,
      resourceId: 'res-1' as any,
      operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'res-2' } }] as any,
    });
    expect(sse.bindAnnotation).toHaveBeenCalledTimes(1);

    // Backend confirms the bind by emitting bind:finished with the new annotation
    const updatedAnnotation = makeAnnotation('ann-1', 'res-2');
    eventBus.get('bind:finished').next({ annotation: updatedAnnotation } as any);

    // The flow must have called updateInPlace with the branded RID and the
    // updated annotation — no HTTP refetch
    expect(updateInPlace).toHaveBeenCalledTimes(1);
    expect(updateInPlace).toHaveBeenCalledWith(RID, updatedAnnotation);
    expect(browseAnnotations).not.toHaveBeenCalled();

    sub.unsubscribe();
  });

  it('emits bind:body-updated with annotation.id after a successful bind', () => {
    const seen: any[] = [];
    eventBus.get('bind:body-updated').subscribe((e) => seen.push(e));

    const sub = engine.bind(RID, () => undefined);

    eventBus.get('bind:update-body').next({
      annotationId: AID,
      resourceId: 'res-1' as any,
      operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'res-2' } }] as any,
    });

    eventBus.get('bind:finished').next({
      annotation: makeAnnotation('ann-1', 'res-2'),
    } as any);

    expect(seen).toHaveLength(1);
    expect(seen[0].annotationId).toBe('ann-1');

    sub.unsubscribe();
  });

  it('annotation.id mismatch on bind:finished does not update or unsubscribe', () => {
    const sub = engine.bind(RID, () => undefined);

    eventBus.get('bind:update-body').next({
      annotationId: AID,
      resourceId: 'res-1' as any,
      operations: [] as any,
    });

    // bind:finished for a different annotation — must be ignored
    eventBus.get('bind:finished').next({
      annotation: makeAnnotation('ann-OTHER', 'res-X'),
    } as any);

    expect(updateInPlace).not.toHaveBeenCalled();

    // The original subscription should still be active — emit a matching one
    eventBus.get('bind:finished').next({
      annotation: makeAnnotation('ann-1', 'res-2'),
    } as any);

    expect(updateInPlace).toHaveBeenCalledTimes(1);
    expect(updateInPlace).toHaveBeenCalledWith(RID, expect.objectContaining({ id: 'ann-1' }));

    sub.unsubscribe();
  });

  it('bind:failed unsubscribes the finishedSub — subsequent bind:finished is ignored', () => {
    const sub = engine.bind(RID, () => undefined);

    eventBus.get('bind:update-body').next({
      annotationId: AID,
      resourceId: 'res-1' as any,
      operations: [] as any,
    });

    // Failure tears down the per-operation subscriptions
    eventBus.get('bind:failed').next({ error: 'something broke' } as any);

    // A late bind:finished should NOT trigger updateInPlace
    eventBus.get('bind:finished').next({
      annotation: makeAnnotation('ann-1', 'res-2'),
    } as any);

    expect(updateInPlace).not.toHaveBeenCalled();

    sub.unsubscribe();
  });
});
