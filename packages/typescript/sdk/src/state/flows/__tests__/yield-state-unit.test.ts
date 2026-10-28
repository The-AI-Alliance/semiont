import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable } from 'rxjs';
import { createYieldStateUnit, type YieldStateUnit } from '../yield-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { resourceContextFor, annotationContextFor } from '../../../__tests__/fixtures/gathered-context';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

// The job's resource is derived FROM the focus — the state unit passes the
// context through untouched, so these fixtures are the whole identity story.
const CTX_ANN = annotationContextFor('res-1', 'ref-ann-1');
const CTX_RES = resourceContextFor('res-1');

function withYield(delegateFn: ReturnType<typeof vi.fn>): TestClient {
  return makeTestClient({ yield: { delegate: delegateFn } });
}

// All lifecycle flows through the delegation `client.yield.delegate` returns —
// yield-state-unit subscribes to no bus channel directly. Tests drive
// lifecycle by `next`/`complete`/`error`-ing the mocked Observable that
// `delegate` returns.
describe('createYieldStateUnit', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  // The unit's arguments ARE `yield.delegate`'s, so every parameter the job
  // takes, and the stall deadline, reach it untouched — no per-field
  // restatement to fall behind.

  it('forwards outputMediaType — every other parameter, and the stall deadline — untouched', () => {
    const delegateFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');

    stateUnit.generate({
      title: 'Test',
      storageUri: 'store://t',
      outputMediaType: 'application/pdf',
      entityTypes: ['Concept'],
      task: 'summary',
      context: CTX_RES,
    }, 90_000);

    expect(delegateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMediaType: 'application/pdf',
        entityTypes: ['Concept'],
        task: 'summary',
        context: CTX_RES,
      }),
      90_000,
    );
    stateUnit.dispose();
  });

  it('omitting a knob sends no key at all — the worker default governs, not a UI-manufactured one', () => {
    const delegateFn = vi.fn((_params: unknown) => new Observable(() => {}));
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');

    stateUnit.generate({ title: 'Test', storageUri: 'store://t', context: CTX_RES });

    const params = delegateFn.mock.calls[0]![0];
    expect(params).toHaveProperty('title', 'Test'); // we grabbed the right argument
    expect(params).not.toHaveProperty('outputMediaType');
    stateUnit.dispose();
  });
});

describe('YieldStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    const opts = { title: 'T', storageUri: 'file://x' };
    // Gateway stub errors synchronously: drive()'s error path runs (no throw) and
    // the unit holds no timer, so none leaks across runs.
    const stub = () => new Observable((s) => s.error(new Error('axiom-stub')));
    assertStateUnitAxioms<YieldStateUnit>({
      setup: () => {
        const tc = makeTestClient({ yield: { delegate: vi.fn(stub) } });
        return { unit: createYieldStateUnit(tc.client, 'en'), teardown: () => tc.bus.destroy() };
      },
      surfaces: (u) => [u.isGenerating$, u.progress$, u.outcome$, u.failure$, u.jobId$],
      invocations: (u) => [() => u.generate({ ...opts, context: CTX_ANN }), () => u.generate({ ...opts, context: CTX_RES })],
      numRuns: 15,
    });
  });
});
