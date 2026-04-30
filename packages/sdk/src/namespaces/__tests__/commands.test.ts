import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import { MarkNamespace } from '../mark';
import { BindNamespace } from '../bind';
import { GatherNamespace } from '../gather';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
import type { ITransport, IContentTransport } from '@semiont/core';

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
    const result = await m.annotation({ motivation: 'highlighting', target: { source: RID } } as any);
    expect(mock.emitSpy).toHaveBeenCalledWith('mark:create-request', expect.objectContaining({ resourceId: RID }));
    expect(result.annotationId).toBe('ann-new');
  });

  it('delete() emits mark:delete on bus', async () => {
    await mark.delete(RID, AID);
    expect(emitSpy).toHaveBeenCalledWith('mark:delete', { annotationId: AID, resourceId: RID });
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
      jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'reference-annotation',
      percentage: 50, progress: { stage: 'scanning', percentage: 50, message: 'scanning' },
    } as any);
    eventBus.get('job:complete').next({
      jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'reference-annotation',
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
      jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'reference-annotation',
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
      jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'highlight-annotation',
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
    gather.annotation(RID, AID, { contextWindow: 2000 }).subscribe(() => {});
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
      gather.annotation(RID, AID).subscribe({ next: () => {}, complete: () => resolve() });
    });

    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[1]?.correlationId;
    eventBus.get('gather:complete').next({ correlationId: cid, annotationId: AID, response: { context: {} } } as any);
    await completed;
  });

  it('annotation() errors on gather:failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      gather.annotation(RID, AID).subscribe({ error: (err) => resolve(err) });
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
    match.search(RID, annotationId('ref-1'), {} as any).subscribe(() => {});
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
      match.search(RID, annotationId('ref-1'), {} as any).subscribe({ next: () => {}, complete: () => resolve() });
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[1]?.correlationId;
    eventBus.get('match:search-results').next({ correlationId: cid, referenceId: 'ref-1', response: [] } as any);
    await completed;
  });

  it('search() errors on match:search-failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      match.search(RID, annotationId('ref-1'), {} as any).subscribe({ error: (err) => resolve(err) });
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

  it('resource() emits started → progress* → finished as the upload runs', async () => {
    // Capture the onProgress hook so we can drive byte progress from
    // outside the namespace, simulating what HttpContentTransport's XHR
    // path would feed in.
    let captured: { onProgress?: (e: { bytesUploaded: number; totalBytes: number }) => void } = {};
    let resolveUpload!: (value: { resourceId: string }) => void;
    const uploadPromise = new Promise<{ resourceId: string }>((r) => { resolveUpload = r; });
    (content.putBinary as ReturnType<typeof vi.fn>).mockImplementation((_req: unknown, opts: typeof captured) => {
      captured = opts ?? {};
      return uploadPromise;
    });

    const events: any[] = [];
    const file = Buffer.from(new Uint8Array(1024)); // 1 KB pre-flight size
    yld.resource({ name: 'doc', file, format: 'text/plain', storageUri: 'file://x' } as any).subscribe({
      next: (e) => events.push(e),
    });

    // `started` fires synchronously on subscribe.
    expect(events).toEqual([{ phase: 'started', totalBytes: 1024 }]);

    // Drive a couple of progress events through the captured hook.
    captured.onProgress?.({ bytesUploaded: 512, totalBytes: 1024 });
    captured.onProgress?.({ bytesUploaded: 1024, totalBytes: 1024 });

    expect(events).toEqual([
      { phase: 'started', totalBytes: 1024 },
      { phase: 'progress', bytesUploaded: 512, totalBytes: 1024 },
      { phase: 'progress', bytesUploaded: 1024, totalBytes: 1024 },
    ]);

    // Resolve the upload; `finished` fires.
    resolveUpload({ resourceId: 'res-new' });
    await uploadPromise;
    // Allow the .then() callback to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(events.at(-1)).toMatchObject({ phase: 'finished' });
    expect(events.filter((e) => e.phase === 'progress')).toHaveLength(2);
  });

  it('resource() falls back to pre-flight totalBytes when the transport reports total=0', async () => {
    let captured: { onProgress?: (e: { bytesUploaded: number; totalBytes: number }) => void } = {};
    (content.putBinary as ReturnType<typeof vi.fn>).mockImplementation((_req: unknown, opts: typeof captured) => {
      captured = opts ?? {};
      return new Promise(() => { /* never resolves; we only assert progress shape here */ });
    });

    const events: any[] = [];
    yld.resource({
      name: 'doc',
      file: Buffer.from(new Uint8Array(2048)),
      format: 'text/plain',
      storageUri: 'file://x',
    } as any).subscribe({ next: (e) => events.push(e) });

    captured.onProgress?.({ bytesUploaded: 256, totalBytes: 0 });

    expect(events.at(-1)).toEqual({ phase: 'progress', bytesUploaded: 256, totalBytes: 2048 });
  });

  it('resource() aborts the in-flight upload when the subscriber unsubscribes', () => {
    let capturedSignal: AbortSignal | undefined;
    (content.putBinary as ReturnType<typeof vi.fn>).mockImplementation(
      (_req: unknown, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        return new Promise(() => { /* never resolves */ });
      },
    );

    const sub = yld.resource({
      name: 'doc',
      file: Buffer.from('xx'),
      format: 'text/plain',
      storageUri: 'file://x',
    } as any).subscribe({ next: () => {} });

    expect(capturedSignal?.aborted).toBe(false);
    sub.unsubscribe();
    expect(capturedSignal?.aborted).toBe(true);
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
      jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'generation',
      percentage: 50, progress: { stage: 'generating', percentage: 50, message: 'halfway' },
    } as any);
    eventBus.get('job:complete').next({
      jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'generation',
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
      jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'generation',
      result: { resourceName: 'T' },
    } as any);
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });
});

/**
 * Regression guard for the browser-upload bug surfaced at /know/compose:
 * `yield.resource()` referenced the Node global `Buffer` directly via
 * `data.file instanceof Buffer`, which throws `ReferenceError: Buffer
 * is not defined` synchronously in browsers (Buffer is not a browser
 * global).
 *
 * The fix gates the Buffer branch on a runtime check
 * (`typeof Buffer !== 'undefined'`); these tests pin that behavior
 * by deleting `globalThis.Buffer` and verifying the upload path
 * still works for File-shaped inputs.
 */
describe('YieldNamespace.resource — runtime fallback when Buffer is unavailable', () => {
  let savedBuffer: typeof globalThis.Buffer | undefined;
  let eventBus: EventBus;
  let content: IContentTransport;
  let yld: YieldNamespace;

  beforeEach(() => {
    eventBus = new EventBus();
    content = makeMockContent();
    const mock = createMockTransport();
    yld = new YieldNamespace(mock.transport, eventBus, content);

    // Force-undefine `Buffer` to model a browser runtime. Saved so we
    // can restore it for sibling tests that depend on `Buffer.from(...)`.
    savedBuffer = globalThis.Buffer;
    delete (globalThis as unknown as { Buffer?: unknown }).Buffer;
  });

  afterEach(() => {
    if (savedBuffer !== undefined) {
      (globalThis as unknown as { Buffer: typeof globalThis.Buffer }).Buffer = savedBuffer;
    }
  });

  it('emits started → finished with a File-shaped input when Buffer is undefined', async () => {
    // Browser shape: an object with `.size`, no Buffer involvement.
    const file = { size: 4096 } as File;

    const events: any[] = [];
    yld.resource({ name: 'doc', file, format: 'text/plain', storageUri: 'file://x' } as any).subscribe({
      next: (e) => events.push(e),
      error: (e) => events.push({ kind: 'error', error: e }),
    });

    // Pre-fix this would throw `Buffer is not defined` synchronously
    // before `started` ever fires. With the typeof guard, the Buffer
    // branch is short-circuited and the size is read from `.size`.
    expect(events[0]).toEqual({ phase: 'started', totalBytes: 4096 });
    expect(events.some((e) => e.kind === 'error')).toBe(false);

    // Let the mocked putBinary resolve and `finished` to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(events.at(-1)).toMatchObject({ phase: 'finished' });
  });

  it('passes the File through to content.putBinary unchanged', async () => {
    const file = { size: 1024 } as File;
    yld.resource({ name: 'doc', file, format: 'text/plain', storageUri: 'file://x' } as any).subscribe();

    await new Promise((r) => setTimeout(r, 0));
    expect(content.putBinary).toHaveBeenCalledWith(
      expect.objectContaining({ file, name: 'doc' }),
      expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }),
    );
  });
});
