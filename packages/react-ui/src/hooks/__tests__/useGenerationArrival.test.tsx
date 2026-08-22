/**
 * GENERATION-ARRIVAL P2 — the reveal's arming logic, pinned at the hook seam.
 *
 * A finished from-resource generation mints a provenance reference on the
 * source (YIELD-FROM-RESOURCE Fork 2b: motivation `linking`, resource-level
 * target, body pointing at the new resource). When the OUTCOME arrives while
 * the page is mounted, the hook finds that edge and calls `onReveal` with its
 * id — exactly once per run (A3/D8). An outcome already held at mount (the
 * user navigated away and back; `outcome$` is a BehaviorSubject) must NOT
 * fire (D6): the arrival was not witnessed, so nothing is announced.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Annotation, AnnotationId } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import type { YieldOutcome } from '@semiont/sdk';
import { useGenerationArrival } from '../useGenerationArrival';

const outcomeFor = (target: string): YieldOutcome => ({
  resourceId: makeResourceId(target),
  resourceName: 'Generated Doc',
  truncated: false,
});

/** The provenance edge the worker mints: linking, resource-level, resolved from birth. */
const provenanceRef = (id: string, newResourceId: string): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: id as AnnotationId,
  type: 'Annotation',
  motivation: 'linking',
  created: '2026-08-21T12:00:00Z',
  modified: '2026-08-21T12:00:00Z',
  target: { source: 'res-src' },
  body: { type: 'SpecificResource', source: newResourceId, purpose: 'linking' },
});

type HookProps = { outcome: YieldOutcome | null; annotations: Annotation[] };

const renderArrival = (initial: HookProps) => {
  const onReveal = vi.fn<(annotationId: string) => void>();
  const utils = renderHook(
    ({ outcome, annotations }: HookProps) => useGenerationArrival(outcome, annotations, onReveal),
    { initialProps: initial },
  );
  return { ...utils, onReveal };
};

describe('useGenerationArrival', () => {
  it('a fresh outcome with its provenance edge present reveals once', () => {
    const { rerender, onReveal } = renderArrival({ outcome: null, annotations: [] });
    rerender({
      outcome: outcomeFor('res-new'),
      annotations: [provenanceRef('ann-prov', 'res-new')],
    });
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith('ann-prov');
  });

  it('re-renders with the same outcome do not re-reveal (A3)', () => {
    const o = outcomeFor('res-new');
    const anns = [provenanceRef('ann-prov', 'res-new')];
    const { rerender, onReveal } = renderArrival({ outcome: null, annotations: [] });
    rerender({ outcome: o, annotations: anns });
    rerender({ outcome: o, annotations: anns });
    rerender({ outcome: o, annotations: [...anns] });
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('an outcome already held at mount never reveals (D6 — the remount case)', () => {
    // outcome$ is a BehaviorSubject: a remounted page receives the SAME held
    // object on every render. Identity is the arrival contract — the unit
    // emits one object per completion — so the held object re-delivered is
    // not an arrival.
    const held = outcomeFor('res-new');
    const anns = [provenanceRef('ann-prov', 'res-new')];
    const { rerender, onReveal } = renderArrival({ outcome: held, annotations: anns });
    rerender({ outcome: held, annotations: anns });
    rerender({ outcome: held, annotations: [...anns] });
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('an outcome arriving before its edge waits, then reveals when it lands', () => {
    // mark:create for the provenance ref is awaited before job:complete, so
    // in practice the edge is already projected — this pin covers the
    // ordering anyway (the plan's P2 worklist names it).
    const { rerender, onReveal } = renderArrival({ outcome: null, annotations: [] });
    rerender({ outcome: outcomeFor('res-new'), annotations: [] });
    expect(onReveal).not.toHaveBeenCalled();
    rerender({
      outcome: outcomeFor('res-new'),
      annotations: [provenanceRef('ann-prov', 'res-new')],
    });
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith('ann-prov');
  });

  it("a second run's outcome reveals its own edge", () => {
    const { rerender, onReveal } = renderArrival({ outcome: null, annotations: [] });
    rerender({
      outcome: outcomeFor('res-new-1'),
      annotations: [provenanceRef('ann-1', 'res-new-1')],
    });
    rerender({
      outcome: outcomeFor('res-new-2'),
      annotations: [provenanceRef('ann-1', 'res-new-1'), provenanceRef('ann-2', 'res-new-2')],
    });
    expect(onReveal).toHaveBeenCalledTimes(2);
    expect(onReveal).toHaveBeenLastCalledWith('ann-2');
  });

  it('an unrelated linking annotation is not the edge — no reveal without a match', () => {
    const { rerender, onReveal } = renderArrival({ outcome: null, annotations: [] });
    rerender({
      outcome: outcomeFor('res-new'),
      annotations: [provenanceRef('ann-other', 'res-elsewhere')],
    });
    expect(onReveal).not.toHaveBeenCalled();
  });
});
