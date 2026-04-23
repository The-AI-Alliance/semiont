/**
 * Unit tests for worker-process orchestration.
 *
 * The `handleJob` function in worker-process.ts owns the end-to-end
 * contract from a claimed job through to completion. Under the unified
 * job:* lifecycle, every invocation emits:
 *
 *   job:start                                  (at entry)
 *     → for each returned annotation: mark:create
 *                                                 (annotation jobs)
 *     → session.client.yield.resource(...)
 *                                                 (generation only; creates the resource)
 *     → job:complete                            (at success exit)
 *
 * Post-WORKER-SESSIONS refactor, the worker runs on top of a
 * `SemiontSession`. Tests use a fake session whose `client.actor.emit`
 * captures bus emits, `client.browse.resourceContent` returns test
 * content, and `client.yield.resource` captures the multipart upload
 * for generation. No raw `fetch` or `WorkerVM` involved.
 *
 * On failure the outer wrapper (startWorkerProcess) emits `job:fail`
 * and calls adapter.failJob(); we exercise that by letting a processor
 * throw and checking the caller handles it.
 *
 * Processors' return values are covered by processors.test.ts. This
 * file covers the iterate-and-emit orchestration layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActiveJob, JobClaimAdapter, SemiontSession } from '@semiont/api-client';
import { handleJob, type WorkerProcessConfig } from '../worker-process';
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
} from '../processors';

// Mock all six processors. Each test sets its own return value.
vi.mock('../processors', async () => ({
  processHighlightJob:  vi.fn(),
  processCommentJob:    vi.fn(),
  processAssessmentJob: vi.fn(),
  processReferenceJob:  vi.fn(),
  processTagJob:        vi.fn(),
  processGenerationJob: vi.fn(),
}));

const RID = 'res-abc';
const UID = 'did:web:example.com:users:test';
const JID = 'job-xyz';

/** Captured interactions — bus emits, complete/fail, and yield.resource call. */
interface BusEmit { channel: string; payload: unknown; scope?: string | undefined; }
interface AdapterCall { method: 'completeJob' | 'failJob'; args: unknown[]; }

function makeFakeSessionAndAdapter() {
  const busEmits: BusEmit[] = [];
  const yieldResourceCalls: Parameters<SemiontSession['client']['yield']['resource']>[0][] = [];
  const adapterCalls: AdapterCall[] = [];

  const session = {
    client: {
      actor: {
        emit: vi.fn(async (channel: string, payload: Record<string, unknown>, scope?: string) => {
          busEmits.push({ channel, payload, scope });
        }),
      },
      browse: {
        resourceContent: vi.fn(async (_rid: string) => 'the content'),
      },
      yield: {
        resource: vi.fn(async (data: Parameters<SemiontSession['client']['yield']['resource']>[0]) => {
          yieldResourceCalls.push(data);
          return { resourceId: 'new-res-42' };
        }),
      },
    },
  } as unknown as SemiontSession;

  const adapter = {
    completeJob: vi.fn(() => adapterCalls.push({ method: 'completeJob', args: [] })),
    failJob: vi.fn((jid: string, err: string) => adapterCalls.push({ method: 'failJob', args: [jid, err] })),
  } as unknown as JobClaimAdapter;

  return { session, adapter, busEmits, yieldResourceCalls, adapterCalls };
}

function makeConfig(session: SemiontSession): WorkerProcessConfig {
  return {
    session,
    jobTypes: [],
    inferenceClient: {} as never,
    generator: {
      '@type': 'SoftwareAgent',
      name: 'test-worker',
      worker: 'worker-pool',
      inferenceProvider: 'ollama',
      model: 'test',
    } as never,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(function(this: any){ return this; }) } as never,
  };
}

function makeJob(type: ActiveJob['type'], paramsOverride: Record<string, unknown> = {}): ActiveJob {
  return {
    jobId: JID,
    type,
    resourceId: RID,
    userId: UID,
    params: { resourceId: RID, ...paramsOverride },
  } as ActiveJob;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleJob orchestration', () => {

  // ── Annotation jobs — all five follow the same shape. Each suite asserts:
  //   (1) processor was called
  //   (2) leads with `job:start` carrying jobId + jobType
  //   (3) exactly N `mark:create` emits (N = returned annotation count), in order
  //   (4) exactly one `job:complete` emit carrying jobType + result
  //   (5) adapter.completeJob called exactly once, AFTER the above

  describe('highlight-annotation', () => {
    it('emits job:start, mark:create per annotation, then job:complete', async () => {
      vi.mocked(processHighlightJob).mockResolvedValue({
        annotations: [{ id: 'a1' }, { id: 'a2' }] as never,
        result: { highlightsFound: 2, highlightsCreated: 2 } as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('highlight-annotation'));

      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'mark:create', 'job:complete']);
      expect(h.busEmits[3]!.payload).toMatchObject({ jobType: 'highlight-annotation', result: { highlightsFound: 2 } });
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('comment-annotation', () => {
    it('emits job:start, one mark:create, then job:complete', async () => {
      vi.mocked(processCommentJob).mockResolvedValue({
        annotations: [{ id: 'c1' }] as never,
        result: { commentsFound: 1, commentsCreated: 1 } as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('comment-annotation'));

      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'job:complete']);
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('assessment-annotation', () => {
    it('emits job:start, mark:create per annotation, then job:complete', async () => {
      vi.mocked(processAssessmentJob).mockResolvedValue({
        annotations: [{ id: 'a1' }] as never,
        result: { assessmentsFound: 1, assessmentsCreated: 1 } as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('assessment-annotation'));

      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'job:complete']);
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('reference-annotation', () => {
    it('emits job:start, mark:create per annotation, then job:complete', async () => {
      vi.mocked(processReferenceJob).mockResolvedValue({
        annotations: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] as never,
        result: { totalFound: 3, totalEmitted: 3, errors: 0 } as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('reference-annotation'));

      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'mark:create', 'mark:create', 'job:complete']);
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('tag-annotation', () => {
    it('emits job:start, mark:create per annotation, then job:complete', async () => {
      vi.mocked(processTagJob).mockResolvedValue({
        annotations: [{ id: 't1' }] as never,
        result: { tagsFound: 1, tagsCreated: 1 } as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('tag-annotation'));

      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'job:complete']);
      expect(h.busEmits[2]!.payload).toMatchObject({
        jobType: 'tag-annotation',
        result: { tagsFound: 1, tagsCreated: 1 },
      });
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('generation', () => {
    it('uploads content via session.client.yield.resource, then emits job:complete with resourceId + resourceName', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: '# Generated\n\nBody.',
        title: 'New Resource',
        format: 'text/markdown',
        result: { tokensUsed: 100 } as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('generation', { referenceId: 'ref-1', prompt: 'Write about X', language: 'en' }));

      // Verify the upload went through session.client.yield.resource
      // (not a raw fetch to /resources) with the expected fields.
      expect(h.yieldResourceCalls).toHaveLength(1);
      const uploaded = h.yieldResourceCalls[0]!;
      expect(uploaded.name).toBe('New Resource');
      expect(uploaded.format).toBe('text/markdown');
      expect(uploaded.creationMethod).toBe('generated');
      expect(uploaded.sourceResourceId).toBe(RID);
      expect(uploaded.sourceAnnotationId).toBe('ref-1');
      expect(uploaded.generationPrompt).toBe('Write about X');
      expect(uploaded.language).toBe('en');
      expect(uploaded.generator).toBeTruthy();

      // Bus emits: job:start then job:complete (no yield:create, no mark:create).
      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'job:complete']);
      expect(h.busEmits[1]!.payload).toMatchObject({
        jobType: 'generation',
        result: { resourceId: 'new-res-42', resourceName: 'New Resource' },
      });
      expect(h.busEmits.map(e => e.channel)).not.toContain('yield:create');
      expect(h.busEmits.map(e => e.channel)).not.toContain('mark:create');
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });

    it('propagates upload errors so the caller can translate to job:fail', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: 'body',
        title: 'T',
        format: 'text/markdown',
        result: {} as never,
      });
      const h = makeFakeSessionAndAdapter();
      vi.mocked(h.session.client.yield.resource).mockRejectedValueOnce(new Error('Upload failed: 500'));

      await expect(
        handleJob(h.adapter, makeConfig(h.session), makeJob('generation', { referenceId: 'ref-1' }))
      ).rejects.toThrow(/Upload failed: 500/);
    });
  });

  describe('unknown job type', () => {
    it('calls adapter.failJob with a descriptive message after emitting job:start', async () => {
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('weird-thing' as never));

      // job:start fires before the dispatch branch; unknown path calls failJob.
      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start']);
      const fail = h.adapterCalls.find(c => c.method === 'failJob');
      expect(fail).toBeDefined();
      expect(fail!.args[0]).toBe(JID);
      expect(String(fail!.args[1])).toMatch(/Unknown job type: weird-thing/);
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(0);
    });
  });

  describe('processor throws', () => {
    it('propagates the error (caller wraps with job:fail + adapter.failJob)', async () => {
      vi.mocked(processReferenceJob).mockRejectedValue(new Error('inference blew up'));
      const h = makeFakeSessionAndAdapter();

      await expect(
        handleJob(h.adapter, makeConfig(h.session), makeJob('reference-annotation'))
      ).rejects.toThrow('inference blew up');

      // On failure, handleJob itself does NOT emit job:complete.
      // job:start still fires at entry; the outer wrapper emits job:fail.
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(false);
      expect(h.adapterCalls.filter(c => c.method === 'completeJob')).toHaveLength(0);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Helper: emitEvent's resource-broadcast routing.
//
// RESOURCE_BROADCAST_TYPES lists channels whose payloads carry a
// resource-scoped broadcast semantic — `job:complete` and `job:fail`.
// handleJob's emitEvent helper must route those with `scope: resourceId`
// so per-resource subscribers (not just the initiator) receive them.
// All other channels emit globally with no scope.
// ──────────────────────────────────────────────────────────────────────

describe('handleJob — resource-broadcast scope routing', () => {
  it('emits job:complete with scope=resourceId (resource broadcast)', async () => {
    vi.mocked(processHighlightJob).mockResolvedValue({
      annotations: [] as never,
      result: {} as never,
    });
    const h = makeFakeSessionAndAdapter();

    await handleJob(h.adapter, makeConfig(h.session), makeJob('highlight-annotation'));

    const completeEmit = h.busEmits.find(e => e.channel === 'job:complete');
    expect(completeEmit).toBeDefined();
    expect(completeEmit!.scope).toBe(RID);
  });

  it('emits job:start globally (no scope — not a resource broadcast)', async () => {
    vi.mocked(processHighlightJob).mockResolvedValue({
      annotations: [] as never,
      result: {} as never,
    });
    const h = makeFakeSessionAndAdapter();

    await handleJob(h.adapter, makeConfig(h.session), makeJob('highlight-annotation'));

    const startEmit = h.busEmits.find(e => e.channel === 'job:start');
    expect(startEmit).toBeDefined();
    expect(startEmit!.scope).toBeUndefined();
  });

  it('emits mark:create globally (the per-annotation create command is not a resource broadcast)', async () => {
    vi.mocked(processHighlightJob).mockResolvedValue({
      annotations: [{ id: 'a1' }] as never,
      result: {} as never,
    });
    const h = makeFakeSessionAndAdapter();

    await handleJob(h.adapter, makeConfig(h.session), makeJob('highlight-annotation'));

    const createEmit = h.busEmits.find(e => e.channel === 'mark:create');
    expect(createEmit).toBeDefined();
    expect(createEmit!.scope).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// startWorkerProcess — the outer wrapper that creates a job-claim
// adapter from session.client.actor, subscribes to activeJob$, and
// translates handleJob rejections into job:fail + adapter.failJob.
// ──────────────────────────────────────────────────────────────────────

describe('startWorkerProcess', () => {
  // Import lazily so the top-level vi.mock of ../processors applies.
  const loadStartWorkerProcess = async () => {
    const mod = await import('../worker-process');
    return mod.startWorkerProcess;
  };

  // We need an actor whose `emit`/`addChannels`/`on$` satisfy the
  // adapter, plus a way to push an activeJob$ value after start().
  // The adapter internally subscribes to `job:queued` and emits
  // `job:claim`; we skip that whole dance and directly shove a job
  // through by calling the activeJob$ subscriber from inside the
  // adapter. Easiest path: mock `createJobClaimAdapter` to return
  // a controllable fake.
  it('subscribes to activeJob$ and dispatches handleJob on each emitted job', async () => {
    const { BehaviorSubject } = await import('rxjs');
    const activeJob$ = new BehaviorSubject<ActiveJob | null>(null);
    const completeJob = vi.fn();
    const failJob = vi.fn();
    const adapterStart = vi.fn();

    vi.doMock('@semiont/api-client', async () => {
      const actual = await vi.importActual<typeof import('@semiont/api-client')>('@semiont/api-client');
      return {
        ...actual,
        createJobClaimAdapter: vi.fn(() => ({
          activeJob$: activeJob$.asObservable(),
          isProcessing$: { subscribe: vi.fn() },
          jobsCompleted$: { subscribe: vi.fn() },
          errors$: { subscribe: vi.fn() },
          start: adapterStart,
          stop: vi.fn(),
          completeJob,
          failJob,
          dispose: vi.fn(),
        })),
      };
    });
    vi.resetModules();

    const startWorkerProcess = await loadStartWorkerProcess();

    vi.mocked(processHighlightJob).mockResolvedValue({
      annotations: [] as never,
      result: {} as never,
    });

    const h = makeFakeSessionAndAdapter();
    startWorkerProcess(makeConfig(h.session));

    // Adapter was started exactly once.
    expect(adapterStart).toHaveBeenCalledTimes(1);

    // Push a job onto activeJob$ — the subscription should run handleJob.
    activeJob$.next(makeJob('highlight-annotation'));
    // Let handleJob's async chain settle.
    await new Promise((r) => setTimeout(r, 0));

    // handleJob emitted job:start → job:complete on the fake session.
    expect(h.busEmits.map((e) => e.channel)).toContain('job:start');
    expect(h.busEmits.map((e) => e.channel)).toContain('job:complete');

    vi.doUnmock('@semiont/api-client');
    vi.resetModules();
  });

  it('emits job:fail + calls adapter.failJob when handleJob rejects', async () => {
    const { BehaviorSubject } = await import('rxjs');
    const activeJob$ = new BehaviorSubject<ActiveJob | null>(null);
    const completeJob = vi.fn();
    const failJob = vi.fn();
    const adapterStart = vi.fn();

    vi.doMock('@semiont/api-client', async () => {
      const actual = await vi.importActual<typeof import('@semiont/api-client')>('@semiont/api-client');
      return {
        ...actual,
        createJobClaimAdapter: vi.fn(() => ({
          activeJob$: activeJob$.asObservable(),
          isProcessing$: { subscribe: vi.fn() },
          jobsCompleted$: { subscribe: vi.fn() },
          errors$: { subscribe: vi.fn() },
          start: adapterStart,
          stop: vi.fn(),
          completeJob,
          failJob,
          dispose: vi.fn(),
        })),
      };
    });
    vi.resetModules();

    const startWorkerProcess = await loadStartWorkerProcess();

    vi.mocked(processReferenceJob).mockRejectedValueOnce(new Error('inference blew up'));

    const h = makeFakeSessionAndAdapter();
    startWorkerProcess(makeConfig(h.session));

    activeJob$.next(makeJob('reference-annotation', { referenceId: 'ann-1' }));
    await new Promise((r) => setTimeout(r, 10));

    // Outer handler emits job:fail on the bus and calls adapter.failJob.
    const failEmit = h.busEmits.find((e) => e.channel === 'job:fail');
    expect(failEmit).toBeDefined();
    expect(failEmit!.payload).toMatchObject({
      jobId: JID,
      jobType: 'reference-annotation',
      annotationId: 'ann-1',
      error: 'inference blew up',
    });
    expect(failEmit!.scope).toBe(RID);
    expect(failJob).toHaveBeenCalledWith(JID, 'inference blew up');

    vi.doUnmock('@semiont/api-client');
    vi.resetModules();
  });
});
