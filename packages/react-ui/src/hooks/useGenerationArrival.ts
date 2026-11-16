import { useEffect, useRef } from 'react';
import type { Annotation } from '@semiont/core';
import { getBodySource } from '@semiont/core';
import type { YieldOutcome } from '@semiont/sdk';

/**
 * The reveal's arming logic (GENERATION-ARRIVAL P2).
 *
 * A finished from-resource generation mints a provenance reference on the
 * source (YIELD-FROM-RESOURCE Fork 2b) — the durable edge worth announcing.
 * When the outcome ARRIVES while this page is mounted, find that edge among
 * the source's annotations and call `onReveal` with its id, exactly once per
 * run (A3/D8). The host decides what a reveal IS (open the panel, scroll,
 * sparkle); this hook only decides WHEN.
 *
 * An outcome already held at mount never fires (D6): `outcome$` is a
 * BehaviorSubject, so navigating away and back re-delivers the old outcome —
 * an arrival nobody witnessed is not an arrival.
 */
export function useGenerationArrival(
  outcome: YieldOutcome | null,
  annotations: Annotation[],
  onReveal: (annotationId: string) => void,
): void {
  // Pre-seed with the mount-time outcome so a held value cannot fire (D6).
  const seen = useRef(outcome);
  // Armed between the outcome arriving and its edge appearing — usually the
  // same render (the worker awaits the edge's mark:create before
  // job:complete), but the ordering is not this hook's to assume.
  const pending = useRef<YieldOutcome | null>(null);
  const onRevealRef = useRef(onReveal);
  useEffect(() => { onRevealRef.current = onReveal; });

  useEffect(() => {
    if (outcome && outcome !== seen.current) {
      seen.current = outcome;
      pending.current = outcome;
    }
    if (!pending.current) return;

    const target = String(pending.current.resourceId);
    const edge = annotations.find(
      (a) => a.motivation === 'linking' && String(getBodySource(a.body) ?? '') === target,
    );
    if (edge) {
      pending.current = null;
      onRevealRef.current(edge.id);
    }
  }, [outcome, annotations]);
}
