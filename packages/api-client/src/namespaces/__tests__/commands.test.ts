/**
 * Command Namespace Tests
 *
 * Tests the mark, bind, gather, match, and yield namespace methods.
 * Verifies HTTP delegation, Observable wiring, and error handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import { MarkNamespace } from '../mark';
import { BindNamespace } from '../bind';
import { GatherNamespace } from '../gather';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
import type { SemiontApiClient } from '../../client';

const RID = resourceId('res-1');
const AID = annotationId('ann-1');

function makeHttp(overrides: Record<string, any> = {}) {
  return {
    markAnnotation: vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
    deleteAnnotation: vi.fn().mockResolvedValue(undefined),
    addEntityType: vi.fn().mockResolvedValue(undefined),
    addEntityTypesBulk: vi.fn().mockResolvedValue(undefined),
    updateResource: vi.fn().mockResolvedValue(undefined),
    bindAnnotation: vi.fn().mockResolvedValue({ correlationId: 'c1' }),
    annotateReferences: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateHighlights: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateComments: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateAssessments: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    annotateTags: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    gatherAnnotationContext: vi.fn().mockResolvedValue({ correlationId: 'c1' }),
    matchSearch: vi.fn().mockResolvedValue({ correlationId: 'c1' }),
    yieldResource: vi.fn().mockResolvedValue({ resourceId: 'res-new' }),
    yieldResourceFromAnnotation: vi.fn().mockResolvedValue({ correlationId: 'c1', jobId: 'j1' }),
    generateCloneToken: vi.fn().mockResolvedValue({ token: 'tok', expiresAt: '2026-01-01' }),
    getResourceByToken: vi.fn().mockResolvedValue({ sourceResource: { name: 'Clone' }, expiresAt: '2026-01-01' }),
    createResourceFromToken: vi.fn().mockResolvedValue({ resourceId: 'res-clone' }),
    ...overrides,
  } as unknown as SemiontApiClient;
}

// ── Mark ────────────────────────────────────────────────────────────────────

describe('MarkNamespace', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let mark: MarkNamespace;

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttp();
    mark = new MarkNamespace(http, eventBus, () => 'tok' as any);
  });

  it('annotation() delegates to markAnnotation', async () => {
    const result = await mark.annotation(RID, { motivation: 'highlighting', target: { source: RID }, body: [] } as any);
    expect(http.markAnnotation).toHaveBeenCalledWith(RID, expect.anything(), { auth: 'tok' });
    expect(result.annotationId).toBe('ann-new');
  });

  it('delete() delegates to deleteAnnotation', async () => {
    await mark.delete(RID, AID);
    expect(http.deleteAnnotation).toHaveBeenCalledWith(RID, AID, { auth: 'tok' });
  });

  it('entityType() delegates to addEntityType', async () => {
    await mark.entityType('Person');
    expect(http.addEntityType).toHaveBeenCalled();
  });

  it('archive() calls updateResource with archived: true', async () => {
    await mark.archive(RID);
    expect(http.updateResource).toHaveBeenCalledWith(RID, { archived: true }, { auth: 'tok' });
  });

  it('assist() returns Observable that emits on mark:progress', async () => {
    const progress: any[] = [];
    const completed = new Promise<void>((resolve) => {
      mark.assist(RID, 'linking', { entityTypes: ['Person'] }).subscribe({
        next: (p) => progress.push(p),
        complete: () => resolve(),
      });
    });

    // Simulate backend progress events
    await new Promise((r) => setTimeout(r, 10));
    eventBus.get('mark:progress').next({ resourceId: 'res-1', status: 'scanning', percentage: 50 } as any);
    eventBus.get('mark:assist-finished').next({ resourceId: 'res-1', motivation: 'linking', foundCount: 3 } as any);

    await completed;
    expect(progress.length).toBeGreaterThan(0);
  });

  it('assist() falls back to job polling when SSE is silent', async () => {
    vi.useFakeTimers();
    const getJobStatus = vi.fn().mockResolvedValue({ status: 'complete', result: { createdCount: 5 } });
    const httpWithPoll = makeHttp({ getJobStatus });
    const bus = new EventBus();
    const m = new MarkNamespace(httpWithPoll, bus, () => 'tok' as any);

    const progress: any[] = [];
    let completed = false;
    m.assist(RID, 'highlighting', {}).subscribe({
      next: (p) => progress.push(p),
      complete: () => { completed = true; },
    });

    // Let HTTP dispatch resolve (delivers jobId)
    await vi.advanceTimersByTimeAsync(100);

    // No SSE events — advance past poll start delay (10s) + first poll interval (5s)
    await vi.advanceTimersByTimeAsync(16_000);

    expect(getJobStatus).toHaveBeenCalled();
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it('assist() SSE completion wins over polling', async () => {
    vi.useFakeTimers();
    const getJobStatus = vi.fn();
    const httpWithPoll = makeHttp({ getJobStatus });
    const bus = new EventBus();
    const m = new MarkNamespace(httpWithPoll, bus, () => 'tok' as any);

    let completed = false;
    m.assist(RID, 'linking', { entityTypes: ['Person'] }).subscribe({
      next: () => {},
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);

    // SSE delivers before poll starts
    bus.get('mark:assist-finished').next({ resourceId: 'res-1', motivation: 'linking' } as any);
    expect(completed).toBe(true);
    expect(getJobStatus).not.toHaveBeenCalled();

    bus.destroy();
    vi.useRealTimers();
  });

  it('assist() progress resets poll timer', async () => {
    vi.useFakeTimers();
    const getJobStatus = vi.fn().mockResolvedValue({ status: 'running' });
    const httpWithPoll = makeHttp({ getJobStatus });
    const bus = new EventBus();
    const m = new MarkNamespace(httpWithPoll, bus, () => 'tok' as any);

    m.assist(RID, 'highlighting', {}).subscribe({ next: () => {}, error: () => {} });

    await vi.advanceTimersByTimeAsync(100);

    // At 9s, send progress — resets the 10s timer
    await vi.advanceTimersByTimeAsync(9_000);
    bus.get('mark:progress').next({ resourceId: 'res-1', status: 'scanning', percentage: 50 } as any);

    // At 18s (9s after progress) — still within 10s window, no polling yet
    await vi.advanceTimersByTimeAsync(9_000);
    expect(getJobStatus).not.toHaveBeenCalled();

    bus.destroy();
    vi.useRealTimers();
  });
});

// ── Bind ────────────────────────────────────────────────────────────────────

describe('BindNamespace', () => {
  it('body() delegates to bindAnnotation', async () => {
    const http = makeHttp();
    const bind = new BindNamespace(http, () => 'tok' as any);
    await bind.body(RID, AID, [{ op: 'add', item: { type: 'SpecificResource', source: 'res-2' } }]);
    expect(http.bindAnnotation).toHaveBeenCalledWith(RID, AID, { operations: expect.any(Array) }, { auth: 'tok' });
  });
});

// ── Gather ──────────────────────────────────────────────────────────────────

describe('GatherNamespace', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let gather: GatherNamespace;

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttp();
    gather = new GatherNamespace(http, eventBus, () => 'tok' as any);
  });

  it('annotation() fires HTTP POST', () => {
    gather.annotation(AID, RID, { contextWindow: 2000 }).subscribe(() => {});
    // Allow microtask for HTTP call
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(http.gatherAnnotationContext).toHaveBeenCalled();
      resolve();
    }, 20));
  });

  it('annotation() completes on gather:complete', async () => {
    const mockResponse = { context: { annotation: {} } };
    const completed = new Promise<void>((resolve) => {
      gather.annotation(AID, RID).subscribe({ next: () => {}, complete: () => resolve() });
    });

    await new Promise((r) => setTimeout(r, 20));
    const call = (http.gatherAnnotationContext as ReturnType<typeof vi.fn>).mock.calls[0];
    const cid = call?.[2]?.correlationId;
    eventBus.get('gather:complete').next({ correlationId: cid, annotationId: AID, response: mockResponse } as any);
    await completed;
  });

  it('annotation() errors on gather:failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      gather.annotation(AID, RID).subscribe({ error: (err) => resolve(err) });
    });

    await new Promise((r) => setTimeout(r, 20));
    const call = (http.gatherAnnotationContext as ReturnType<typeof vi.fn>).mock.calls[0];
    const cid = call?.[2]?.correlationId;
    eventBus.get('gather:failed').next({ correlationId: cid, annotationId: AID, message: 'boom' } as any);
    const err = await errored;
    expect(err.message).toContain('boom');
  });
});

// ── Match ───────────────────────────────────────────────────────────────────

describe('MatchNamespace', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let match: MatchNamespace;

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttp();
    match = new MatchNamespace(http, eventBus, () => 'tok' as any);
  });

  it('search() fires HTTP POST', () => {
    match.search(RID, 'ref-1', {} as any).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(http.matchSearch).toHaveBeenCalled();
      resolve();
    }, 20));
  });

  it('search() completes on match:search-results', async () => {
    const completed = new Promise<void>((resolve) => {
      match.search(RID, 'ref-1', {} as any).subscribe({ next: () => {}, complete: () => resolve() });
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = (http.matchSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    const cid = call?.[1]?.correlationId;
    eventBus.get('match:search-results').next({ correlationId: cid, referenceId: 'ref-1', response: [] } as any);
    await completed;
  });

  it('search() errors on match:search-failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      match.search(RID, 'ref-1', {} as any).subscribe({ error: (err) => resolve(err) });
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = (http.matchSearch as ReturnType<typeof vi.fn>).mock.calls[0];
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

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttp();
    yld = new YieldNamespace(http, eventBus, () => 'tok' as any);
  });

  it('resource() delegates to yieldResource', async () => {
    const result = await yld.resource({ name: 'doc', file: new Blob(['hi']), format: 'text/plain', storageUri: 'file://x' } as any);
    expect(http.yieldResource).toHaveBeenCalled();
    expect(result.resourceId).toBe('res-new');
  });

  it('fromAnnotation() fires HTTP POST', () => {
    yld.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(http.yieldResourceFromAnnotation).toHaveBeenCalled();
      resolve();
    }, 20));
  });

  it('fromAnnotation() emits progress and completes on yield:finished', async () => {
    const progress: any[] = [];
    const completed = new Promise<void>((resolve) => {
      yld.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe({
        next: (p) => progress.push(p),
        complete: () => resolve(),
      });
    });

    await new Promise((r) => setTimeout(r, 20));
    eventBus.get('yield:progress').next({ referenceId: AID, status: 'generating', percentage: 50, message: 'halfway' } as any);
    eventBus.get('yield:finished').next({ referenceId: AID, status: 'complete', percentage: 100, resourceId: 'res-gen', sourceResourceId: 'res-1' } as any);

    await completed;
    expect(progress.length).toBeGreaterThanOrEqual(1);
  });

  it('cloneToken() delegates to generateCloneToken', async () => {
    await yld.cloneToken(RID);
    expect(http.generateCloneToken).toHaveBeenCalledWith(RID, { auth: 'tok' });
  });

  it('fromAnnotation() falls back to job polling when SSE is silent', async () => {
    vi.useFakeTimers();
    const getJobStatus = vi.fn().mockResolvedValue({ status: 'complete', result: { resourceId: 'res-poll' } });
    const httpWithPoll = makeHttp({ getJobStatus });
    const bus = new EventBus();
    const y = new YieldNamespace(httpWithPoll, bus, () => 'tok' as any);

    const progress: unknown[] = [];
    let completed = false;
    y.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe({
      next: (p) => progress.push(p),
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(getJobStatus).toHaveBeenCalled();
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it('fromAnnotation() SSE completion wins over polling', async () => {
    vi.useFakeTimers();
    const getJobStatus = vi.fn();
    const httpWithPoll = makeHttp({ getJobStatus });
    const bus = new EventBus();
    const y = new YieldNamespace(httpWithPoll, bus, () => 'tok' as any);

    let completed = false;
    y.fromAnnotation(RID, AID, { title: 'T', storageUri: 'file://x', context: {} as any }).subscribe({
      next: () => {},
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    bus.get('yield:finished').next({ referenceId: AID, status: 'complete', resourceId: 'res-sse', sourceResourceId: 'res-1' } as any);
    expect(completed).toBe(true);
    expect(getJobStatus).not.toHaveBeenCalled();

    bus.destroy();
    vi.useRealTimers();
  });
});
