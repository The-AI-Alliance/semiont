import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable } from 'rxjs';
import { resourceId as makeResourceId } from '@semiont/core';
import { createMarkStateUnit, type MarkStateUnit } from '../mark-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

const RID = makeResourceId('res-1');

function withMark(overrides: Partial<{
  annotation: ReturnType<typeof vi.fn>;
  delegate: ReturnType<typeof vi.fn>;
}> = {}): TestClient {
  return makeTestClient({
    mark: {
      annotation: overrides.annotation ?? vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
      delegate: overrides.delegate ?? vi.fn(() => new Observable(() => {})),
    },
  });
}

describe('createMarkStateUnit', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('does not emit panel:open on mark:requested (view layer handles panel)', () => {
    // The view component is responsible for opening the annotations panel
    // in response to `pendingAnnotation$` — the state unit stays pure state, and
    // `panel:open` lives on the app-scoped (SemiontBrowser) bus anyway,
    // which this session-scoped client doesn't reach.
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const panels: string[] = [];
    tc.bus.on('panel:open').subscribe(e => panels.push(e.panel));

    tc.bus.emit('mark:requested', { source: RID, selector: { type: 'TextQuoteSelector', exact: 'a passage' }, motivation: 'highlighting' });
    expect(panels).toEqual([]);
    stateUnit.dispose();
  });
});

describe('MarkStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    assertStateUnitAxioms<MarkStateUnit>({
      setup: () => {
        const tc = withMark();
        return { unit: createMarkStateUnit(tc.client, RID), teardown: () => tc.bus.destroy() };
      },
      surfaces: (u) => [u.pendingAnnotation$, u.delegatingMotivation$, u.progress$, u.progressMotivation$, u.jobId$, u.failure$],
      invocations: (u) => [() => u.requestDelegate({ motivation: 'highlighting' }), () => u.cancelPending(), () => u.dismissProgress()],
    });
  });
});
