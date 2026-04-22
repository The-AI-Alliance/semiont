import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import { MarkNamespace } from '../mark';
import { BindNamespace } from '../bind';
import { GatherNamespace } from '../gather';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
import type { SemiontApiClient } from '../../client';
import type { ActorVM, BusEvent, ConnectionState } from '../../view-models/domain/actor-vm';

const RID = resourceId('res-1');
const AID = annotationId('ann-1');

function createMockActor(responses: Record<string, (payload: Record<string, unknown>) => { resultChannel: string; response: Record<string, unknown> }> = {}): { actor: ActorVM; emitSpy: ReturnType<typeof vi.fn> } {
  const events$ = new Subject<BusEvent>();
  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    const handler = responses[channel];
    if (handler) {
      const { resultChannel, response } = handler(payload);
      const correlationId = payload.correlationId as string;
      queueMicrotask(() => {
        events$.next({ channel: resultChannel, payload: { correlationId, response } });
      });
    }
  });

  const actor: ActorVM = {
    on$<T = Record<string, unknown>>(channel: string) {
      return events$.pipe(
        filter((e) => e.channel === channel),
        map((e) => e.payload as T),
      );
    },
    emit: emitSpy,
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    addChannels: vi.fn(),
    removeChannels: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  };

  return { actor, emitSpy };
}

function makeHttp(overrides: Record<string, any> = {}) {
  return {
    markAnnotation: vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
    updateResource: vi.fn().mockResolvedValue(undefined),
    annotateReferences: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateHighlights: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateComments: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateAssessments: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateTags: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    yieldResource: vi.fn().mockResolvedValue({ resourceId: 'res-new' }),
    yieldResourceFromAnnotation: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    getJobStatus: vi.fn().mockResolvedValue({ status: 'running' }),
    // YieldNamespace.fromAnnotation's yield:finished handler calls
    // client.bind.body(...) to attach the generated resource as a
    // SpecificResource on the source annotation.
    bind: { body: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  } as unknown as SemiontApiClient;
}

// ── Mark ────────────────────────────────────────────────────────────────────

describe('MarkNamespace', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let mark: MarkNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttp();
    const mock = createMockActor({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    emitSpy = mock.emitSpy;
    mark = new MarkNamespace(http, eventBus, () => 'tok' as any, mock.actor);
  });

  it('annotation() emits mark:create-request on bus', async () => {
    const mock = createMockActor({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
      'mark:create-request': () => ({ resultChannel: 'mark:create-ok', response: { annotationId: 'ann-new' } }),
    });
    const m = new MarkNamespace(makeHttp(), eventBus, () => 'tok' as any, mock.actor);
    const result = await m.annotation(RID, { motivation: 'highlighting', target: { source: RID } } as any);
    expect(mock.emitSpy).toHaveBeenCalledWith('mark:create-request', expect.objectContaining({ resourceId: RID }));
    expect(result.annotationId).toBe('ann-new');
  });

  it('delete() emits mark:delete on bus', async () => {
    await mark.delete(RID, AID);
    expect(emitSpy).toHaveBeenCalledWith('mark:delete', { annotationId: AID, resourceId: RID });
  });

  it('entityType() emits mark:add-entity-type on bus', async () => {
    await mark.entityType('Person');
    expect(emitSpy).toHaveBeenCalledWith('mark:add-entity-type', { tag: 'Person' });
  });

  it('archive() emits mark:archive on bus', async () => {
    await mark.archive(RID);
    expect(emitSpy).toHaveBeenCalledWith('mark:archive', { resourceId: RID });
  });

  it('assist() returns Observable that emits on job:report-progress', async () => {
    const progress: any[] = [];
    const completed = new Promise<void>((resolve) => {
      mark.assist(RID, 'linking', { entityTypes: ['Person'] }).subscribe({
        next: (p) => progress.push(p),
        complete: () => resolve(),
      });
    });

    await new Promise((r) => setTimeout(r, 10));
    // Unified lifecycle: filter by the jobId (`j1`) assigned by job:create.
    // assist() forwards the inner `progress` field as the Observable's `next`.
    eventBus.get('job:report-progress').next({
      jobId: 'j1', resourceId: 'res-1', userId: 'u', jobType: 'reference-annotation',
      percentage: 50, progress: { stage: 'scanning', percentage: 50, message: 'scanning' },
    } as any);
    eventBus.get('job:complete').next({
      jobId: 'j1', resourceId: 'res-1', userId: 'u', jobType: 'reference-annotation',
      result: { totalFound: 3, totalEmitted: 3, errors: 0 },
    } as any);

    await completed;
    expect(progress.length).toBeGreaterThan(0);
  });

  it('assist() falls back to job polling when SSE is silent', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockActor({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
      'job:status-requested': () => ({ resultChannel: 'job:status-result', response: { status: 'complete', result: { createdCount: 5 } } }),
    });
    const m = new MarkNamespace(makeHttp(), bus, () => 'tok' as any, mock.actor);

    const progress: any[] = [];
    let completed = false;
    m.assist(RID, 'highlighting', {}).subscribe({
      next: (p) => progress.push(p),
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(mock.emitSpy).toHaveBeenCalledWith('job:status-requested', expect.any(Object));
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it('assist() SSE completion wins over polling', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockActor({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    const m = new MarkNamespace(makeHttp(), bus, () => 'tok' as any, mock.actor);

    let completed = false;
    m.assist(RID, 'linking', { entityTypes: ['Person'] }).subscribe({
      next: () => {},
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    bus.get('job:complete').next({
      jobId: 'j1', resourceId: 'res-1', userId: 'u', jobType: 'reference-annotation',
      result: { totalFound: 0, totalEmitted: 0, errors: 0 },
    } as any);
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it('assist() progress resets poll timer', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockActor({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    const m = new MarkNamespace(makeHttp(), bus, () => 'tok' as any, mock.actor);

    m.assist(RID, 'highlighting', {}).subscribe({ next: () => {}, error: () => {} });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(9_000);
    bus.get('job:report-progress').next({
      jobId: 'j1', resourceId: 'res-1', userId: 'u', jobType: 'highlight-annotation',
      percentage: 50, progress: { stage: 'scanning', percentage: 50, message: 'scanning' },
    } as any);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(mock.emitSpy).not.toHaveBeenCalledWith('job:status-requested', expect.any(Object));

    bus.destroy();
    vi.useRealTimers();
  });
});

// ── Bind ────────────────────────────────────────────────────────────────────

describe('BindNamespace', () => {
  it('body() emits bind:update-body on bus', async () => {
    const mock = createMockActor();
    const bind = new BindNamespace(mock.actor);
    await bind.body(RID, AID, [{ op: 'add', item: { type: 'SpecificResource', source: 'res-2' } }]);
    expect(mock.emitSpy).toHaveBeenCalledWith('bind:update-body', expect.objectContaining({
      annotationId: AID,
      resourceId: RID,
      operations: expect.any(Array),
    }));
  });
});

// ── Gather ──────────────────────────────────────────────────────────────────

describe('GatherNamespace', () => {
  let eventBus: EventBus;
  let gather: GatherNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    const mock = createMockActor();
    emitSpy = mock.emitSpy;
    gather = new GatherNamespace(eventBus, mock.actor);
  });

  it('annotation() emits gather:requested on bus', () => {
    gather.annotation(AID, RID, { contextWindow: 2000 }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('gather:requested', expect.objectContaining({
        annotationId: AID,
        resourceId: RID,
        contextWindow: 2000,
      }));
      resolve();
    }, 20));
  });

  it('annotation() completes on gather:complete', async () => {
    const completed = new Promise<void>((resolve) => {
      gather.annotation(AID, RID).subscribe({ next: () => {}, complete: () => resolve() });
    });

    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[1]?.correlationId;
    eventBus.get('gather:complete').next({ correlationId: cid, annotationId: AID, response: { context: {} } } as any);
    await completed;
  });

  it('annotation() errors on gather:failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      gather.annotation(AID, RID).subscribe({ error: (err) => resolve(err) });
    });

    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[1]?.correlationId;
    eventBus.get('gather:failed').next({ correlationId: cid, annotationId: AID, message: 'boom' } as any);
    const err = await errored;
    expect(err.message).toContain('boom');
  });
});

// ── Match ───────────────────────────────────────────────────────────────────

describe('MatchNamespace', () => {
  let eventBus: EventBus;
  let match: MatchNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    const mock = createMockActor();
    emitSpy = mock.emitSpy;
    match = new MatchNamespace(eventBus, mock.actor);
  });

  it('search() emits match:search-requested on bus', () => {
    match.search(RID, 'ref-1', {} as any).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('match:search-requested', expect.objectContaining({
        resourceId: RID,
        referenceId: 'ref-1',
      }));
      resolve();
    }, 20));
  });

  it('search() completes on match:search-results', async () => {
    const completed = new Promise<void>((resolve) => {
      match.search(RID, 'ref-1', {} as any).subscribe({ next: () => {}, complete: () => resolve() });
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[1]?.correlationId;
    eventBus.get('match:search-results').next({ correlationId: cid, referenceId: 'ref-1', response: [] } as any);
    await completed;
  });

  it('search() errors on match:search-failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      match.search(RID, 'ref-1', {} as any).subscribe({ error: (err) => resolve(err) });
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[1]?.correlationId;
    eventBus.get('match:search-failed').next({ correlationId: cid, referenceId: 'ref-1', error: 'no results' } as any);
    const err = await errored;
    expect(err.message).toContain('no results');
  });
});

// ── Yield ───────────────────────────────────────────────────────────────────

describe('YieldNamespace', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let yld: YieldNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttp();
    const mock = createMockActor({
      'yield:clone-token-requested': () => ({
        resultChannel: 'yield:clone-token-generated',
        response: { token: 'tok', expiresAt: '2026-01-01' },
      }),
      'job:create': () => ({
        resultChannel: 'job:created',
        response: { jobId: 'j1' },
      }),
    });
    emitSpy = mock.emitSpy;
    yld = new YieldNamespace(http, eventBus, () => 'tok' as any, mock.actor);
  });

  it('resource() delegates to yieldResource', async () => {
    const result = await yld.resource({ name: 'doc', file: new Blob(['hi']), format: 'text/plain', storageUri: 'file://x' } as any);
    expect(http.yieldResource).toHaveBeenCalled();
    expect(result.resourceId).toBe('res-new');
  });

  it('fromAnnotation() emits job:create on bus', () => {
    yld.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        jobType: 'generation',
        resourceId: RID,
      }));
      resolve();
    }, 20));
  });

  it('fromAnnotation() emits progress and completes on job:complete', async () => {
    const progress: any[] = [];
    const completed = new Promise<void>((resolve) => {
      yld.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe({
        next: (p) => progress.push(p),
        complete: () => resolve(),
      });
    });

    await new Promise((r) => setTimeout(r, 20));
    eventBus.get('job:report-progress').next({
      jobId: 'j1', resourceId: 'res-1', userId: 'u', jobType: 'generation',
      percentage: 50, progress: { stage: 'generating', percentage: 50, message: 'halfway' },
    } as any);
    eventBus.get('job:complete').next({
      jobId: 'j1', resourceId: 'res-1', userId: 'u', jobType: 'generation',
      result: { resourceName: 'T' },
    } as any);

    await completed;
    expect(progress.length).toBeGreaterThanOrEqual(1);
  });

  it('cloneToken() uses bus request', async () => {
    const result = await yld.cloneToken(RID);
    expect(result).toEqual({ token: 'tok', expiresAt: '2026-01-01' });
  });

  it('fromAnnotation() falls back to job polling when SSE is silent', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockActor({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
      'job:status-requested': () => ({ resultChannel: 'job:status-result', response: { status: 'complete', result: { resourceId: 'res-poll' } } }),
    });
    const y = new YieldNamespace(makeHttp(), bus, () => 'tok' as any, mock.actor);

    const progress: unknown[] = [];
    let completed = false;
    y.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe({
      next: (p) => progress.push(p),
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(mock.emitSpy).toHaveBeenCalledWith('job:status-requested', expect.any(Object));
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it('fromAnnotation() SSE completion wins over polling', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockActor({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    const y = new YieldNamespace(makeHttp(), bus, () => 'tok' as any, mock.actor);

    let completed = false;
    y.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe({
      next: () => {},
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    bus.get('job:complete').next({
      jobId: 'j1', resourceId: 'res-1', userId: 'u', jobType: 'generation',
      result: { resourceName: 'T' },
    } as any);
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });
});
