import { describe, it } from 'vitest';
import { annotationId } from '@semiont/core';
import { createBeckonStateUnit, createHoverDwell, type BeckonStateUnit, type HoverDwell } from '../beckon-state-unit';
import { makeTestClient } from '../../../__tests__/test-client';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

describe('HoverDwell — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    const aid = annotationId('ann-ax');
    assertStateUnitAxioms<HoverDwell>({
      setup: () => createHoverDwell(() => {}, 100),
      invocations: (u) => [() => u.enter(aid), () => u.leave()],
    });
  });
});

describe('BeckonStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    const aid = annotationId('ann-ax');
    assertStateUnitAxioms<BeckonStateUnit>({
      setup: () => {
        const tc = makeTestClient();
        return { unit: createBeckonStateUnit(tc.client), teardown: () => tc.bus.destroy() };
      },
      surfaces: (u) => [u.hoveredAnnotationId$],
      invocations: (u) => [() => u.focus(aid)],
    });
  });
});
