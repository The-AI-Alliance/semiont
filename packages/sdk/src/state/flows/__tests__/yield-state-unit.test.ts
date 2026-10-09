import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import type { components } from '@semiont/core';
import { createYieldStateUnit } from '../yield-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { resourceContextFor, annotationContextFor } from '../../../__tests__/fixtures/gathered-context';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import type { JobEvent } from '../../../awaitable';
import { resourceId, jobId } from '@semiont/core';

type JobProgress = components['schemas']['JobProgress'];
type JobCompleteCommand = components['schemas']['YieldJobCompleteCommand'];

const progressEvent = (p: JobProgress): JobEvent => ({ kind: 'progress', data: p });

const createdEvent = (id: string): JobEvent => ({ kind: 'created', data: { jobId: jobId(id) } });

const completeEvent = (result?: JobCompleteCommand['result']): JobEvent => ({
  kind: 'complete',
  data: {
    resourceId: resourceId('res-1'),
    jobId: jobId('job-1'),
    jobType: 'yield',
    ...(result ? { result } : {}),
  },
});

const GEN_RESULT: JobCompleteCommand['result'] = {
  resourceId: resourceId('res-new-1'),
  resourceName: 'Summary of PB',
  truncated: false,
};

// The job's resource is derived FROM the focus — the state unit passes the
// context through untouched, so these fixtures are the whole identity story.
const CTX_ANN = annotationContextFor('res-1', 'ref-ann-1');
const CTX_RES = resourceContextFor('res-1');

function makeProgress(overrides: Partial<JobProgress> = {}): JobProgress {
  return { percentage: 50, ...overrides };
}

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

  it('initializes with not generating, null progress and no job', () => {
    tc = withYield(vi.fn());
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    const ids: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));
    stateUnit.jobId$.subscribe(v => ids.push(v));
    expect(gen).toEqual([false]);
    expect(prog).toEqual([null]);
    expect(ids).toEqual([null]);
    stateUnit.dispose();
  });

  it('generate() passes its params to client.yield.delegate and defaults language to the locale', () => {
    const delegateFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');

    stateUnit.generate({ title: 'Test', storageUri: 'store://test', context: CTX_ANN });

    expect(delegateFn).toHaveBeenCalledOnce();
    expect(delegateFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Test', language: 'en', context: CTX_ANN }),
      undefined,
    );
    stateUnit.dispose();
  });

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

  it('resource-focus contexts ride the same path — one generate, no second method', () => {
    const delegateFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');

    stateUnit.generate({ title: 'Test', storageUri: 'store://t', context: CTX_RES });

    expect(delegateFn).toHaveBeenCalledOnce();
    expect(delegateFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Test', language: 'en', context: CTX_RES }),
      undefined,
    );
    stateUnit.dispose();
  });

  it('pipes Observable next into progress$ and flips isGenerating=true', () => {
    const p = makeProgress({ percentage: 25 });
    const delegateFn = vi.fn(() => new Observable<JobEvent>((sub) => {
      sub.next(progressEvent(p));
    }));
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });
    expect(prog).toEqual([null, p]);
    expect(gen[gen.length - 1]).toBe(true);
    stateUnit.dispose();
  });

  it('handles multiple next emissions in sequence', () => {
    const progressSubject = new Subject<JobEvent>();
    const delegateFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const prog: unknown[] = [];
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });

    const p1 = makeProgress({ percentage: 30 });
    const p2 = makeProgress({ percentage: 60 });
    progressSubject.next(progressEvent(p1));
    progressSubject.next(progressEvent(p2));
    expect(prog).toEqual([null, p1, p2]);
    stateUnit.dispose();
  });

  it('flips isGenerating=false on complete and KEEPS the finished display', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject<JobEvent>();
    const delegateFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });
    progressSubject.next(progressEvent(makeProgress({ percentage: 75 })));
    progressSubject.complete();

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).not.toBeNull();

    // A finished run stays: no timer dismisses it. Dismissal is explicit.
    vi.advanceTimersByTime(60_000);
    expect(prog[prog.length - 1]).not.toBeNull();

    stateUnit.dismissProgress();
    expect(prog[prog.length - 1]).toBeNull();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  // ── The generation job's id ──────────────────────────────────────
  // What `client.job.cancel` names. A job is named only between the queue's
  // answer to its creation and its end.

  it("holds the generation job's id from the queue's answer to the job's completion", () => {
    const job = new Subject<JobEvent>();
    tc = withYield(vi.fn(() => job.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const ids: unknown[] = [];
    const gen: boolean[] = [];
    stateUnit.jobId$.subscribe(v => ids.push(v));
    stateUnit.isGenerating$.subscribe(v => gen.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    expect(ids.at(-1)).toBeNull();

    job.next(createdEvent('job-1'));
    expect(ids.at(-1)).toBe('job-1');
    // A job the queue holds is not yet a run under way: that begins with its first progress.
    expect(gen.at(-1)).toBe(false);

    job.next(progressEvent(makeProgress({ percentage: 40 })));
    expect(ids.at(-1)).toBe('job-1');

    job.next(completeEvent(GEN_RESULT));
    job.complete();
    expect(ids.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it("forgets the generation job's id when the job ends in an error", () => {
    const job = new Subject<JobEvent>();
    tc = withYield(vi.fn(() => job.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const ids: unknown[] = [];
    stateUnit.jobId$.subscribe(v => ids.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    job.next(createdEvent('job-1'));
    job.error(new Error('The job was cancelled'));

    expect(ids.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it("names the job generated last: not the one before it, whose end does not forget it", () => {
    const first = new Subject<JobEvent>();
    const second = new Subject<JobEvent>();
    const delegateFn = vi.fn()
      .mockImplementationOnce(() => first.asObservable())
      .mockImplementationOnce(() => second.asObservable());
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const ids: unknown[] = [];
    stateUnit.jobId$.subscribe(v => ids.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    first.next(createdEvent('job-1'));

    // The next job's creation is unanswered: the control beside its display has nothing to name.
    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    expect(ids.at(-1)).toBeNull();
    second.next(createdEvent('job-2'));
    expect(ids.at(-1)).toBe('job-2');

    first.complete();
    expect(ids.at(-1)).toBe('job-2');
    stateUnit.dispose();
  });

  it('clears progress and stops generating on Observable error', () => {
    const delegateFn = vi.fn(() => new Observable<JobEvent>((sub) => {
      sub.next(progressEvent(makeProgress({ percentage: 40 })));
      sub.error(new Error('Generation failed'));
    }));
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('holds why a run failed, until it is dismissed or another begins', () => {
    const refused = new Error('the model refused');
    const runs: Array<Subject<JobEvent>> = [];
    tc = withYield(vi.fn(() => {
      const run = new Subject<JobEvent>();
      runs.push(run);
      return run.asObservable();
    }));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const failures: unknown[] = [];
    stateUnit.failure$.subscribe((v) => failures.push(v));
    expect(failures).toEqual([null]);

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });
    runs[0]!.error(refused);
    expect(failures.at(-1)).toBe(refused);
    stateUnit.dismissProgress();
    expect(failures.at(-1)).toBeNull();

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });
    runs[1]!.error(refused);
    expect(failures.at(-1)).toBe(refused);
    // The next run does not begin with the last one's failure.
    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });
    expect(failures.at(-1)).toBeNull();

    // A setback the queue will retry is not one, and neither is a completion.
    runs[2]!.next({ kind: 'failed', data: { resourceId: resourceId('res-1'), jobId: jobId('job-1'), jobType: 'yield', error: 'busy', willRetry: true } });
    runs[2]!.next(completeEvent(GEN_RESULT));
    runs[2]!.complete();
    expect(failures.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  // The unit has no timer of its own: the one stall guard lives in
  // `runGeneration`'s producer, so it cannot be exercised through this
  // file's mocked `delegate`. Its behavior — stall → server-side cancel →
  // typed error → display cleared — is pinned at the stream level in
  // `namespaces/__tests__/generation-stall.test.ts`, including the unit's
  // drive path over the REAL namespace.

  // ── The outcome ─────────────────────────────────────────────────────────────
  // The link's fields come from `job:complete` — the broadcast, after citations
  // attach — which the driven stream already delivers as its `complete`-kind
  // event. The unit holds them so the terminal frame can render a link long
  // after the event has passed.

  it('outcome$ starts null and stays null through progress', () => {
    const progressSubject = new Subject<JobEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    progressSubject.next(progressEvent(makeProgress({ percentage: 95 })));

    expect(out.every(v => v === null)).toBe(true);
    stateUnit.dispose();
  });

  it('outcome$ emits the generation result from the stream complete event', () => {
    const progressSubject = new Subject<JobEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate({ title: 'Summary of PB', storageUri: 's', context: CTX_RES });
    progressSubject.next(completeEvent(GEN_RESULT));
    progressSubject.complete();

    expect(out.at(-1)).toEqual({ resourceId: 'res-new-1', resourceName: 'Summary of PB', truncated: false });
    stateUnit.dispose();
  });

  it('outcome$ carries the truncated bit — the terminal frame derives its sentence from the OUTCOME, not the racing final progress frame', () => {
    const progressSubject = new Subject<JobEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    progressSubject.next(completeEvent({ ...GEN_RESULT, truncated: true }));
    progressSubject.complete();

    expect(out.at(-1)).toEqual({ resourceId: 'res-new-1', resourceName: 'Summary of PB', truncated: true });
    stateUnit.dispose();
  });

  it('a complete event without a generation result leaves outcome$ null', () => {
    const progressSubject = new Subject<JobEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    progressSubject.next(completeEvent());
    progressSubject.complete();

    expect(out.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it('dismissProgress clears the outcome with the frame that displayed it', () => {
    const progressSubject = new Subject<JobEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    progressSubject.next(completeEvent(GEN_RESULT));
    progressSubject.complete();
    expect(out.at(-1)).not.toBeNull();

    stateUnit.dismissProgress();
    expect(out.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it('a new generate() clears the previous outcome', () => {
    const first = new Subject<JobEvent>();
    const second = new Subject<JobEvent>();
    const delegateFn = vi.fn()
      .mockReturnValueOnce(first.asObservable())
      .mockReturnValueOnce(second.asObservable());
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_RES });
    first.next(completeEvent(GEN_RESULT));
    first.complete();
    expect(out.at(-1)).not.toBeNull();

    stateUnit.generate({ title: 'T2', storageUri: 's2', context: CTX_RES });
    expect(out.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it('stops responding after dispose', () => {
    const progressSubject = new Subject<JobEvent>();
    const delegateFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(delegateFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));

    stateUnit.generate({ title: 'T', storageUri: 's', context: CTX_ANN });
    stateUnit.dispose();

    // Any subsequent emission should not update post-dispose state
    progressSubject.next(progressEvent(makeProgress()));
    // The BehaviorSubject completed on dispose; no new emissions from it.
    expect(gen.at(-1)).toBe(false);  // last seen was the dispose teardown
  });
});

describe('YieldStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    const opts = { title: 'T', storageUri: 'file://x' };
    // Gateway stub errors synchronously: drive()'s error path runs (no throw) and
    // the unit holds no timer, so none leaks across runs.
    const stub = () => new Observable((s) => s.error(new Error('axiom-stub')));
    assertStateUnitAxioms({
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
