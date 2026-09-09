/**
 * `outcome$` — the settled terminal verdict of an assist run, mirroring
 * `yield`'s `outcome$` (DETECTION-RESULT-STREAMING P3, RD4).
 *
 * Only SETTLED outcomes enter it: a `complete` event, or a `job:fail` that is
 * terminal (`willRetry !== true`). A retryable failure is a setback inside a
 * live run — "a recovering run is not a state to badge" — and must not settle
 * anything.
 *
 * Absence discipline (RD4): `underReportedPieces` absent on the wire means
 * NONE, mutation-proven on the emitting side. The outcome preserves absence —
 * a manufactured zero here would be the exact lie the jobs suite exists to
 * prevent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Subject } from 'rxjs';
import { resourceId as makeResourceId } from '@semiont/core';
import { createMarkStateUnit } from '../mark-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';

const RID = makeResourceId('res-1');

function harness() {
  const assist$ = new Subject<unknown>();
  const tc = makeTestClient({
    mark: {
      annotation: vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
      delete: vi.fn().mockResolvedValue(undefined),
      assist: vi.fn(() => assist$.asObservable()),
    },
  });
  const unit = createMarkStateUnit(tc.client, RID);
  const outcomes: unknown[] = [];
  unit.outcome$.subscribe((v) => outcomes.push(v));
  const startAssist = () =>
    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
  return { tc, unit, assist$, outcomes, startAssist, last: () => outcomes[outcomes.length - 1] };
}

describe('mark outcome$ — settled terminal verdicts only', () => {
  let tc: TestClient;
  afterEach(() => { tc?.bus.destroy(); });

  it('starts null and stays null through progress frames', () => {
    const h = harness(); tc = h.tc;
    h.startAssist();
    h.assist$.next({ kind: 'progress', data: { jobId: 'j1' } });
    expect(h.outcomes.filter((o) => o !== null)).toEqual([]);
    h.unit.dispose();
  });

  it('a complete event settles a complete outcome, preserving wire absence of underReportedPieces', () => {
    const h = harness(); tc = h.tc;
    h.startAssist();
    h.assist$.next({
      kind: 'complete',
      data: {
        jobId: 'j1', jobType: 'annotation', resourceId: 'res-1',
        result: { kind: 'reference-annotation', totalFound: 5, totalEmitted: 5, errors: 0 },
      },
    });
    const out = h.last() as Record<string, unknown>;
    expect(out).toMatchObject({ kind: 'complete', motivation: 'highlighting' });
    // Absence is the wire's claim of cleanliness — it must survive untouched.
    expect('underReportedPieces' in out).toBe(false);
    h.unit.dispose();
  });

  it('a complete event carries underReportedPieces through when the wire states it', () => {
    const h = harness(); tc = h.tc;
    h.startAssist();
    h.assist$.next({
      kind: 'complete',
      data: {
        jobId: 'j1', jobType: 'annotation', resourceId: 'res-1',
        result: { kind: 'reference-annotation', totalFound: 9, totalEmitted: 6, errors: 0, underReportedPieces: 3 },
      },
    });
    expect(h.last()).toMatchObject({ kind: 'complete', underReportedPieces: 3 });
    h.unit.dispose();
  });

  it('a RETRYABLE failure settles nothing — a recovering run is not a state to badge', () => {
    const h = harness(); tc = h.tc;
    h.startAssist();
    h.assist$.next({ kind: 'failed', data: { jobId: 'j1', resourceId: 'res-1', willRetry: true, error: 'transient' } });
    tc.bus.get('job:fail').next({ jobId: 'j1', jobType: 'annotation', resourceId: 'res-1', error: 'transient', willRetry: true } as any);
    expect(h.outcomes.filter((o) => o !== null)).toEqual([]);
    h.unit.dispose();
  });

  it('a terminal job:fail during an assist settles an incomplete outcome with the wire completedUnits', () => {
    const h = harness(); tc = h.tc;
    h.startAssist();
    tc.bus.get('job:fail').next({
      jobId: 'j1', jobType: 'annotation', resourceId: 'res-1',
      error: 'boom', willRetry: false, completedUnits: ['Person', 'Place'],
    } as any);
    expect(h.last()).toMatchObject({
      kind: 'incomplete', motivation: 'highlighting', completedUnits: ['Person', 'Place'],
    });
    h.unit.dispose();
  });

  it("ignores another resource's terminal fail, a generation fail, and a fail with no assist in flight", () => {
    const h = harness(); tc = h.tc;
    tc.bus.get('job:fail').next({ jobId: 'x', jobType: 'annotation', resourceId: 'res-1', error: 'e', willRetry: false } as any);
    h.startAssist();
    tc.bus.get('job:fail').next({ jobId: 'x', jobType: 'annotation', resourceId: 'OTHER', error: 'e', willRetry: false } as any);
    tc.bus.get('job:fail').next({ jobId: 'x', jobType: 'generation', resourceId: 'res-1', error: 'e', willRetry: false } as any);
    expect(h.outcomes.filter((o) => o !== null)).toEqual([]);
    h.unit.dispose();
  });

  it('the next assist clears the settled outcome; so does mark:progress-dismiss', () => {
    const h = harness(); tc = h.tc;
    h.startAssist();
    h.assist$.next({
      kind: 'complete',
      data: { jobId: 'j1', jobType: 'annotation', resourceId: 'res-1', result: { kind: 'reference-annotation', totalFound: 1, totalEmitted: 1, errors: 0 } },
    });
    expect(h.last()).toMatchObject({ kind: 'complete' });
    h.startAssist();
    expect(h.last()).toBeNull();

    h.assist$.next({
      kind: 'complete',
      data: { jobId: 'j2', jobType: 'annotation', resourceId: 'res-1', result: { kind: 'reference-annotation', totalFound: 1, totalEmitted: 1, errors: 0 } },
    });
    expect(h.last()).toMatchObject({ kind: 'complete' });
    tc.bus.get('mark:progress-dismiss').next({} as any);
    expect(h.last()).toBeNull();
    h.unit.dispose();
  });
});
