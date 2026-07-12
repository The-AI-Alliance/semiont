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
 * `job:complete` / `job:fail` are global, `jobId`-keyed signals (#847) — emitted
 * once, with no resource scope. The dispatching caller filters by `jobId`;
 * resource viewers filter the same global stream by `resourceId`.
 *
 * Post-WORKER-SESSIONS refactor, the worker runs on top of a
 * `SemiontSession`. Tests use a fake session whose `client.actor.emit`
 * captures bus emits, `client.browse.resourceContent` returns test
 * content, and `client.yield.resource` captures the multipart upload
 * for generation. No raw `fetch` or `WorkerStateUnit` involved.
 *
 * On failure the outer wrapper (startWorkerProcess) emits `job:fail`
 * and calls adapter.failJob(); we exercise that by letting a processor
 * throw and checking the caller handles it.
 *
 * Processors' return values are covered by processors.test.ts. This
 * file covers the iterate-and-emit orchestration layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SemiontSession } from '@semiont/sdk';
import type { ActiveJob, JobClaimAdapter } from '../job-claim-adapter';
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

  const transportEmit = vi.fn(async (channel: string, payload: Record<string, unknown>, scope?: string) => {
    busEmits.push({ channel, payload, scope });
  });
  const session = {
    client: {
      transport: {
        emit: transportEmit,
        // `startWorkerProcess` reads `transport.actor` to attach the job-claim
        // adapter; test needs a minimal ActorStateUnit-shaped stand-in.
        actor: {
          on$: vi.fn(() => ({ subscribe: () => ({ unsubscribe: () => {} }) })),
          emit: transportEmit,
          addChannels: vi.fn(),
          removeChannels: vi.fn(),
        },
      },
      browse: {
        // Detection jobs gate on the resource's media type before
        // fetching content; default to a text resource so the happy
        // paths proceed.
        resource: vi.fn(async (_rid: string) => ({
          representations: [{ mediaType: 'text/plain' }],
        })),
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
    jobTypes: ['highlight-annotation', 'comment-annotation', 'assessment-annotation', 'reference-annotation', 'tag-annotation', 'generation'],
    inferenceClient: {} as never,
    generator: {
      '@type': 'Software',
      '@id': 'did:web:example.com:agents:ollama:test',
      name: 'ollama test',
      provider: 'ollama',
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

      expect(h.busEmits.map(e => e.channel))
        .toEqual(['job:start', 'mark:create', 'mark:create', 'job:complete']);
      expect(h.busEmits.find(e => e.channel === 'job:complete')!.payload)
        .toMatchObject({ jobType: 'highlight-annotation', result: { highlightsFound: 2 } });
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

      expect(h.busEmits.map(e => e.channel))
        .toEqual(['job:start', 'mark:create', 'job:complete']);
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

      expect(h.busEmits.map(e => e.channel))
        .toEqual(['job:start', 'mark:create', 'job:complete']);
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

      expect(h.busEmits.map(e => e.channel))
        .toEqual(['job:start', 'mark:create', 'mark:create', 'mark:create', 'job:complete']);
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

      expect(h.busEmits.map(e => e.channel))
        .toEqual(['job:start', 'mark:create', 'job:complete']);
      expect(h.busEmits.find(e => e.channel === 'job:complete')!.payload).toMatchObject({
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
        citations: [],
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
      expect(uploaded.sourceResourceId).toBe(RID);
      expect(uploaded.sourceAnnotationId).toBe('ref-1');
      expect(uploaded.generationPrompt).toBe('Write about X');
      expect(uploaded.language).toBe('en');
      expect(uploaded.generator).toBeTruthy();

      // Bus emits: job:start then job:complete (no yield:create, no mark:create).
      expect(h.busEmits.map(e => e.channel))
        .toEqual(['job:start', 'job:complete']);
      expect(h.busEmits.find(e => e.channel === 'job:complete')!.payload).toMatchObject({
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
        citations: [],
        result: {} as never,
      });
      const h = makeFakeSessionAndAdapter();
      vi.mocked(h.session.client.yield.resource).mockRejectedValueOnce(new Error('Upload failed: 500'));

      await expect(
        handleJob(h.adapter, makeConfig(h.session), makeJob('generation', { referenceId: 'ref-1' }))
      ).rejects.toThrow(/Upload failed: 500/);
    });

    it('forwards entityTypes from job params to the resource upload', async () => {
      // Regression — see .plans/ENTITY-TYPES-GAP.md. The worker is the
      // last stop in the entityTypes pipeline; without this forwarding
      // step `browse.resources({ entityType: 'Character' })` would never
      // surface synthesized resources.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: 'body',
        title: 'T',
        format: 'text/markdown',
        citations: [],
        result: {} as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(
        h.adapter,
        makeConfig(h.session),
        makeJob('generation', {
          referenceId: 'ref-1',
          entityTypes: ['Character', 'Hero'],
        }),
      );

      expect(h.yieldResourceCalls).toHaveLength(1);
      expect(h.yieldResourceCalls[0]!.entityTypes).toEqual(['Character', 'Hero']);
    });

    it('omits entityTypes from the upload when params do not include it (no empty-array stamp)', async () => {
      // Tests the spread-guard at the worker. Without it, generation
      // jobs that don't supply entityTypes would stamp `[]` on the
      // resource — distinct from "field absent", and confusing for
      // downstream queries.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: 'body',
        title: 'T',
        format: 'text/markdown',
        citations: [],
        result: {} as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('generation', { referenceId: 'ref-1' }));

      expect(h.yieldResourceCalls).toHaveLength(1);
      expect(h.yieldResourceCalls[0]!.entityTypes).toBeUndefined();
    });

    it('resource-focus generation (no referenceId) mints a source→derived reference annotation', async () => {
      // YIELD-FROM-RESOURCE Fork 2b. Annotation-focus generation auto-binds via
      // sourceAnnotationId; resource-focus has no triggering reference, so the worker
      // mints a navigable reference: target = the whole source resource (resource-level,
      // no selector), body = SpecificResource → the derived resource.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: 'body', title: 'Derived Doc', format: 'text/markdown', citations: [], result: {} as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('generation', {}));

      expect(h.yieldResourceCalls[0]!.sourceAnnotationId).toBeUndefined(); // no auto-bind

      const markCreate = h.busEmits.find(e => e.channel === 'mark:create');
      expect(markCreate, 'resource-focus generation mints a navigable source→derived reference').toBeDefined();
      expect(markCreate!.payload).toMatchObject({
        annotation: {
          motivation: 'linking',
          target: { source: RID },
          body: { type: 'SpecificResource', source: 'new-res-42', purpose: 'linking' },
        },
      });
      // resource-level target — no selector
      const ann = (markCreate!.payload as { annotation: { target: { selector?: unknown } } }).annotation;
      expect(ann.target.selector).toBeUndefined();

      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'job:complete']);
    });

    it('mints a linking annotation on the DERIVED resource for each resolved citation (INLINE-CITATIONS P1)', async () => {
      // The processor resolved [[ctx-9]] into a claim-span citation; the worker
      // mints it after upload (only then is the derived resourceId known):
      // target = the derived resource + position/quote selectors for the claim,
      // body = SpecificResource → the cited source.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: 'Paris is the capital of France. It is large.',
        title: 'Answer',
        format: 'text/markdown',
        citations: [{ resourceId: 'ctx-9', start: 0, end: 31, exact: 'Paris is the capital of France.' }],
        result: {} as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('generation', { referenceId: 'ref-1', cite: true }));

      const markCreates = h.busEmits.filter(e => e.channel === 'mark:create');
      expect(markCreates, 'one mark:create per resolved citation').toHaveLength(1);
      expect(markCreates[0]!.payload).toMatchObject({
        resourceId: 'new-res-42', // the annotation lives on the DERIVED resource
        annotation: {
          motivation: 'linking',
          target: {
            source: 'new-res-42',
            selector: [
              { type: 'TextPositionSelector', start: 0, end: 31 },
              { type: 'TextQuoteSelector', exact: 'Paris is the capital of France.' },
            ],
          },
          body: { type: 'SpecificResource', source: 'ctx-9', purpose: 'linking' },
        },
      });
      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'job:complete']);
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
      expect(String(fail!.args[1])).toMatch(/Worker not configured for job type: weird-thing/);
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

  // ── Detection media-type gate (MEDIA-TYPES.md Phase 3c) ──────────────
  // browse.resourceContent() sends Accept: text/plain and TextDecoder-
  // decodes whatever returns, so a detection job on a binary resource
  // would feed mojibake to the LLM. The gate checks textExtractionOf
  // on the resource's primary media type before fetching.

  describe('detection media-type gate', () => {
    it('fails a detection job on a binary resource before fetching content or calling the processor', async () => {
      const h = makeFakeSessionAndAdapter();
      vi.mocked(h.session.client.browse.resource).mockResolvedValue({
        representations: [{ mediaType: 'application/zip' }],
      } as never);

      await expect(
        handleJob(h.adapter, makeConfig(h.session), makeJob('reference-annotation'))
      ).rejects.toThrow(/has no extractable text/);

      expect(h.session.client.browse.resourceContent).not.toHaveBeenCalled();
      expect(processReferenceJob).not.toHaveBeenCalled();
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(false);
    });

    it('fails a detection job on a PDF with a distinct not-yet-supported message', async () => {
      const h = makeFakeSessionAndAdapter();
      vi.mocked(h.session.client.browse.resource).mockResolvedValue({
        representations: [{ mediaType: 'application/pdf' }],
      } as never);

      await expect(
        handleJob(h.adapter, makeConfig(h.session), makeJob('highlight-annotation'))
      ).rejects.toThrow(/text-layer detection is not yet supported/);

      expect(h.session.client.browse.resourceContent).not.toHaveBeenCalled();
      expect(processHighlightJob).not.toHaveBeenCalled();
    });

    it('fails a detection job when the resource has no primary representation', async () => {
      const h = makeFakeSessionAndAdapter();
      vi.mocked(h.session.client.browse.resource).mockResolvedValue({
        representations: [],
      } as never);

      await expect(
        handleJob(h.adapter, makeConfig(h.session), makeJob('comment-annotation'))
      ).rejects.toThrow(/has no extractable text/);

      expect(h.session.client.browse.resourceContent).not.toHaveBeenCalled();
    });

    it('proceeds for a registry-miss text subtype (RFC 2046 fallback)', async () => {
      // Imported content can carry unregistered text/* types — the
      // import-leniency invariant. They decode, so detection runs.
      vi.mocked(processCommentJob).mockResolvedValue({
        annotations: [] as never,
        result: { commentsFound: 0, commentsCreated: 0 } as never,
      });
      const h = makeFakeSessionAndAdapter();
      vi.mocked(h.session.client.browse.resource).mockResolvedValue({
        representations: [{ mediaType: 'text/x-custom' }],
      } as never);

      await handleJob(h.adapter, makeConfig(h.session), makeJob('comment-annotation'));

      expect(processCommentJob).toHaveBeenCalled();
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(true);
    });

    it('does not gate generation jobs (they read the annotation, not the source bytes)', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: 'body',
        title: 'T',
        format: 'text/markdown',
        citations: [],
        result: {} as never,
      });
      const h = makeFakeSessionAndAdapter();

      await handleJob(h.adapter, makeConfig(h.session), makeJob('generation', { referenceId: 'ref-1' }));

      expect(h.session.client.browse.resource).not.toHaveBeenCalled();
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(true);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// emitEvent routing.
//
// `job:complete` / `job:fail` are GLOBAL, `jobId`-keyed correlation signals
// (uniform with every other result in the system). The dispatching caller
// filters by `jobId`; resource viewers filter the same global stream by
// `resourceId`. There is no resource-scoped copy — `RESOURCE_BROADCAST_TYPES`
// is empty. All channels emit globally with no scope.
// ──────────────────────────────────────────────────────────────────────

describe('handleJob — global job-completion', () => {
  it('emits job:complete exactly once, globally (no scope)', async () => {
    vi.mocked(processHighlightJob).mockResolvedValue({
      annotations: [] as never,
      result: {} as never,
    });
    const h = makeFakeSessionAndAdapter();

    await handleJob(h.adapter, makeConfig(h.session), makeJob('highlight-annotation'));

    const completes = h.busEmits.filter(e => e.channel === 'job:complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]!.scope).toBeUndefined();
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

    // After the audit move, `createJobClaimAdapter` lives in
    // `./job-claim-adapter` (sibling of worker-process.ts), not in
    // `@semiont/sdk`. Mock the sibling so worker-process picks up the fake.
    vi.doMock('../job-claim-adapter', () => ({
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
    }));
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

    vi.doUnmock('../job-claim-adapter');
    vi.resetModules();
  });

  it('emits job:fail + calls adapter.failJob when handleJob rejects', async () => {
    const { BehaviorSubject } = await import('rxjs');
    const activeJob$ = new BehaviorSubject<ActiveJob | null>(null);
    const completeJob = vi.fn();
    const failJob = vi.fn();
    const adapterStart = vi.fn();

    vi.doMock('../job-claim-adapter', () => ({
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
    }));
    vi.resetModules();

    const startWorkerProcess = await loadStartWorkerProcess();

    vi.mocked(processReferenceJob).mockRejectedValueOnce(new Error('inference blew up'));

    const h = makeFakeSessionAndAdapter();
    startWorkerProcess(makeConfig(h.session));

    activeJob$.next(makeJob('reference-annotation', { referenceId: 'ann-1' }));
    await new Promise((r) => setTimeout(r, 10));

    // Outer handler emits job:fail on the bus and calls adapter.failJob.
    // job:fail is a global, jobId-keyed signal — emitted once, no resource scope.
    const failEmits = h.busEmits.filter((e) => e.channel === 'job:fail');
    expect(failEmits).toHaveLength(1);
    const failEmit = failEmits[0]!;
    expect(failEmit.scope).toBeUndefined();
    expect(failEmit.payload).toMatchObject({
      jobId: JID,
      jobType: 'reference-annotation',
      annotationId: 'ann-1',
      error: 'inference blew up',
    });
    expect(failJob).toHaveBeenCalledWith(JID, 'inference blew up');

    vi.doUnmock('../job-claim-adapter');
    vi.resetModules();
  });
});
