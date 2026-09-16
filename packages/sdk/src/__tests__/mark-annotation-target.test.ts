/**
 * P3 (RESOURCE-LEVEL-ANCHOR) — `mark.annotation` forwards a *selector-less*
 * (whole-resource) target into `mark:create-request` unchanged.
 *
 * The selector-required gate was removed in the schema (P1 — `CreateAnnotationRequest`
 * now `$ref`s `AnnotationTarget`, selector optional) and in core assembly (P2 —
 * `assembleAnnotation` no longer throws when no selector is present). `mark.annotation`
 * itself has no selector logic — it only reads `target.source` for routing and forwards
 * `request` verbatim — so this is a behavioral PIN that the relaxation reaches the SDK
 * emit path: no selector injected, none required. It also pins that a *selectored*
 * target still passes through unchanged, i.e. `mark.annotation` is selector-agnostic
 * both ways. (No SDK code change in P3; the type relaxation landed in P1.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EventBus } from '@semiont/core';
import type { EventMap } from '@semiont/core';
import { MarkNamespace } from '../namespaces/mark';
import type { CreateAnnotationInput } from '../namespaces/types';
import { inMemoryTransport } from './helpers/in-memory-transport';

function makeTransport() {
  const bus = new EventBus();
  let lastChannel: string | null = null;
  let lastPayload: Record<string, unknown> | null = null;
  const transport = inMemoryTransport({
    bus,
    onEmit: (channel, payload) => {
      lastChannel = channel as string;
      lastPayload = payload as Record<string, unknown>;
    },
  });
  return {
    transport,
    // Replies are pushed through the SAME typed bus the transport streams
    // from, so a fixture that is not the channel's declared payload is a
    // compile error rather than something the transport's cast used to hide.
    subjectFor: <K extends keyof EventMap>(channel: K) => bus.get(channel),
    getLastChannel: () => lastChannel,
    getLastPayload: () => lastPayload,
  };
}

describe('mark.annotation — selector-less (whole-resource) target', () => {
  let bus: EventBus;
  afterEach(() => bus?.destroy());

  function makeMark() {
    bus = new EventBus();
    const t = makeTransport();
    return { mark: new MarkNamespace(t.transport, bus), ...t };
  }

  it('forwards a source-only target (a resource edge) with NO selector and resolves', async () => {
    const { mark, subjectFor, getLastChannel, getLastPayload } = makeMark();
    // Claim→Source edge: the target is the whole claim resource (no selector);
    // the body is a SpecificResource pointing at the source resource.
    const input: CreateAnnotationInput = {
      motivation: 'linking',
      target: { source: 'res-claim-1' },
      body: { type: 'SpecificResource', source: 'res-source-1' },
    };

    const promise = mark.annotation(input);
    await Promise.resolve(); // let busRequest subscribe + emit

    expect(getLastChannel()).toBe('mark:create-request');
    const payload = getLastPayload()!;
    expect(payload.resourceId).toBe('res-claim-1'); // routed from target.source
    const req = payload.request as CreateAnnotationInput;
    expect(req.target.source).toBe('res-claim-1');
    expect(req.target.selector).toBeUndefined(); // ← the pin: no selector injected or required
    expect(req.body).toEqual({ type: 'SpecificResource', source: 'res-source-1' });

    const cid = payload.correlationId as string;
    subjectFor('mark:create-ok').next({ correlationId: cid, response: { annotationId: 'ann-1' } });

    expect(await promise).toEqual({ annotationId: 'ann-1' });
  });

  it('still forwards a target WITH a selector unchanged (selector-agnostic both ways)', async () => {
    const { mark, subjectFor, getLastPayload } = makeMark();
    const input: CreateAnnotationInput = {
      motivation: 'commenting',
      target: { source: 'res-doc-1', selector: { type: 'TextPositionSelector', start: 0, end: 10 } },
      body: { type: 'TextualBody', value: 'note' },
    };

    const promise = mark.annotation(input);
    await Promise.resolve();

    const req = getLastPayload()!.request as CreateAnnotationInput;
    expect(req.target.selector).toEqual({ type: 'TextPositionSelector', start: 0, end: 10 });

    const cid = getLastPayload()!.correlationId as string;
    subjectFor('mark:create-ok').next({ correlationId: cid, response: { annotationId: 'ann-2' } });
    await promise;
  });
});
