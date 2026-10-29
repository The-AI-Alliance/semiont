import { describe, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { annotationId, resourceId as makeResourceId } from '@semiont/core';
import { createGatherStateUnit, type GatherStateUnit } from '../gather-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

const RID = makeResourceId('res-1');

function withBothGathers(
  annotationFn: ReturnType<typeof vi.fn>,
  resourceFn: ReturnType<typeof vi.fn>,
): TestClient {
  return makeTestClient({ gather: { annotation: annotationFn, resource: resourceFn } });
}

describe('GatherStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    assertStateUnitAxioms<GatherStateUnit>({
      setup: () => {
        // Gathers that never answer: what the unit does with an answer is the behaviour table's.
        const tc = withBothGathers(vi.fn(() => new Observable(() => {})), vi.fn(() => new Promise(() => {})));
        return { unit: createGatherStateUnit(tc.client, RID), teardown: () => tc.bus.destroy() };
      },
      surfaces: (u) => [
        u.context$, u.loading$, u.error$, u.annotationId$,
        u.resourceContext$, u.resourceLoading$, u.resourceError$,
      ],
      invocations: (u) => [() => u.gatherAnnotation(annotationId('ann-ax')), () => u.gatherResource(RID)],
    });
  });
});
