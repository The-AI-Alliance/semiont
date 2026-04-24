import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import { MarkNamespace } from '../mark';
import { BindNamespace } from '../bind';
import { GatherNamespace } from '../gather';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
import type { ITransport, IContentTransport } from '../../transport/types';

const RID = resourceId('res-1');
const AID = annotationId('ann-1');

/**
 * Mock transport whose `emit(channel, payload)` looks up a handler and
 * pushes the configured `{ correlationId, response }` onto its internal
 * bus, where `stream(resultChannel)` is observable. busRequest reads
 * results via `stream`; this lets tests script per-call request/response
 * round-trips without faking SSE.
 */
function createMockTransport(
  responses: Record<string, (payload: Record<string, unknown>) => { resultChannel: string; response: Record<string, unknown> }> = {},
): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn>; transportBus: EventBus } {
  const transportBus = new EventBus();
  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    const handler = responses[channel];
    if (handler) {
      const { resultChannel, response } = handler(payload);
      const correlationId = payload.correlationId as string;
      queueMicrotask(() => {
        (transportBus.get(resultChannel as never) as { next(v: unknown): void }).next({ correlationId, response });
      });
    }
  });

  const transport = {
    emit: emitSpy,
    on: <K extends never>(channel: K, handler: (p: never) => void) => {
      const sub = (transportBus.get(channel) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: <K extends never>(channel: K) => transportBus.get(channel),
    subscribeToResource: vi.fn().mockReturnValue(() => {}),
    bridgeInto: vi.fn(),
    authenticatePassword: vi.fn(),
    authenticateGoogle: vi.fn(),
    refreshAccessToken: vi.fn(),
    logout: vi.fn(),
    acceptTerms: vi.fn(),
    getCurrentUser: vi.fn(),
    generateMcpToken: vi.fn(),
    getMediaToken: vi.fn(),
    listUsers: vi.fn(),
    getUserStats: vi.fn(),
    updateUser: vi.fn(),
    getOAuthConfig: vi.fn(),
    backupKnowledgeBase: vi.fn(),
    restoreKnowledgeBase: vi.fn(),
    exportKnowledgeBase: vi.fn(),
    importKnowledgeBase: vi.fn(),
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    state$: new BehaviorSubject<'connected'>('connected').asObservable() as never,
    dispose: vi.fn(),
  } as unknown as ITransport;

  return { transport, emitSpy, transportBus };
}

function makeMockContent(): IContentTransport {
  return {
    putBinary: vi.fn().mockResolvedValue({ resourceId: 'res-new' }),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    dispose: vi.fn(),
  };
}

// ── Mark ────────────────────────────────────────────────────────────────────

describe('MarkNamespace', () => {
  let eventBus: EventBus;
  let mark: MarkNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    const mock = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    emitSpy = mock.emitSpy;
    mark = new MarkNamespace(mock.transport, eventBus);
  });

  it('annotation() emits mark:create-request on bus', async () => {
    const mock = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
      'mark:create-request': () => ({ resultChannel: 'mark:create-ok', response: { annotationId: 'ann-new' } }),
    });
    const m = new MarkNamespace(mock.transport, eventBus);
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
    const mock = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
      'job:status-requested': () => ({ resultChannel: 'job:status-result', response: { status: 'complete', result: { createdCount: 5 } } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

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
    const mock = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

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
    const mock = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

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
    const mock = createMockTransport();
    const bind = new BindNamespace(mock.transport, new EventBus());
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
    const mock = createMockTransport();
    emitSpy = mock.emitSpy;
    gather = new GatherNamespace(mock.transport, eventBus);
  });

  it('annotation() emits gather:requested on bus', () => {
    gather.annotation(AID, RID, { contextWindow: 2000 }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('gather:requested', expect.objectContaining({
        annotationId: AID,
        resourceId: RID,
        options: { contextWindow: 2000 },
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
    const mock = createMockTransport();
    emitSpy = mock.emitSpy;
    match = new MatchNamespace(mock.transport, eventBus);
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
  let content: IContentTransport;
  let yld: YieldNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    content = makeMockContent();
    const mock = createMockTransport({
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
    yld = new YieldNamespace(mock.transport, eventBus, content);
  });

  it('resource() delegates to content.putBinary', async () => {
    const result = await yld.resource({ name: 'doc', file: new Blob(['hi']), format: 'text/plain', storageUri: 'file://x' } as any);
    expect(content.putBinary).toHaveBeenCalled();
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
    const mock = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
      'job:status-requested': () => ({ resultChannel: 'job:status-result', response: { status: 'complete', result: { resourceId: 'res-poll' } } }),
    });
    const y = new YieldNamespace(mock.transport, bus, makeMockContent());

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
    const mock = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    });
    const y = new YieldNamespace(mock.transport, bus, makeMockContent());

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
