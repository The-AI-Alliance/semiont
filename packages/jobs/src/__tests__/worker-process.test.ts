/**
 * Unit tests for worker-process orchestration.
 *
 * The `handleJob` function in worker-process.ts owns the end-to-end
 * contract from a claimed job through to completion. Under the unified
 * job:* lifecycle, every invocation emits:
 *
 *   job:start                                  (at entry)
 *     → for each chunk: mark:commit (awaited), then job:checkpoint
 *                                                 (annotation jobs)
 *     → client.yield.resource(...)
 *                                                 (generation only; creates the resource)
 *     → job:complete                            (at success exit)
 *
 * `job:complete` / `job:fail` are global, `jobId`-keyed signals — emitted
 * once, with no resource scope. The dispatching caller filters by `jobId`;
 * resource viewers filter the same global stream by `resourceId`.
 *
 * The worker runs on a `SemiontClient`. Tests use a fake client whose
 * transport captures bus emits and answers `mark:commit` and `job:claim`, a
 * `contentReads.getBinary` double for detection's byte read, and
 * `client.yield.resource` capturing the multipart upload for generation. No
 * raw `fetch` involved.
 *
 * The job a test runs is a REAL held job: the fake transport answers the
 * SDK's own `job.claim` with the record the test states, so what a held job
 * emits, and when it is settled, is the SDK's doing and not this file's.
 *
 * On failure the outer wrapper (startWorkerProcess) fails the held job,
 * which emits `job:fail`; we exercise that by letting a processor throw
 * and checking the caller handles it.
 *
 * Processors' return values are covered by processors.test.ts. This
 * file covers the iterate-and-emit orchestration layer.
 */

import { GEN_REQUIRED, minimalContext } from './fixtures/generation-fixtures';
import type { UnitCheckpoint } from '../processors';
import { Subject, BehaviorSubject, map } from 'rxjs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractPdfTextLayer } from '@semiont/content';
import { JobNamespace, type HeldJob, type SemiontClient } from '@semiont/sdk';
import { BusRequestError, EventBus, HELD_JOB_STALL_CHECK_MS, HELD_JOB_STALL_MS, jobId, resourceId, userId, type EventMap, type ITransport, type UnitCursor } from '@semiont/core';
import type { MarkMotivation } from '../types';
import { recordJobOutcome, withSpan } from '@semiont/observability';
import { handleJob, startWorkerProcess, type WorkerProcessConfig } from '../worker-process';
import { classifyFailure } from '../failure-class';
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
} from '../processors';

// Mock the six processor entry points; keep every other export real.
// `prepareDetection` imports `buildTextAnnotation`/`buildPdfAnnotation` from
// this same module, so replacing it wholesale would leave those undefined —
// spread the original and override only the processors.
vi.mock('../processors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../processors')>()),
  processHighlightJob:  vi.fn(),
  processCommentJob:    vi.fn(),
  processAssessmentJob: vi.fn(),
  processReferenceJob:  vi.fn(),
  processTagJob:        vi.fn(),
  processGenerationJob: vi.fn(),
}));

// Real telemetry, watched: what a job is labelled with is asserted below, and
// everything else in the module runs as it does in the worker.
vi.mock('@semiont/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/observability')>();
  return { ...actual, recordJobOutcome: vi.fn(actual.recordJobOutcome), withSpan: vi.fn(actual.withSpan) };
});

// Stub only `extractPdfTextLayer`, so generation's citation tests supply a
// text layer without real PDF fixtures; everything else in @semiont/content
// stays real. Detection's extracted-vs-declined decision is driven by the
// session's `browse.resourceAnchoredText` double, not by this mock.
vi.mock('@semiont/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/content')>();
  return {
    ...actual,
    // PDF citation geometry: the worker re-anchors claims through the
    // extracted text layer; tests supply it.
    extractPdfTextLayer: vi.fn(),
  };
});

/**
 * Detection's byte read. Module-level so assertions can reach the spy while
 * `makeConfig` keeps its one-argument shape; `vi.clearAllMocks()` clears the
 * calls between tests but leaves this implementation in place.
 *
 * It hangs off the config rather than the session because detection reads
 * from the Archivist, not through the gateway. The bytes are inert — every
 * extractor these tests exercise is mocked per test.
 */
const getBinary = vi.fn(async () => ({ data: new ArrayBuffer(8), contentType: 'application/pdf' }));

const RID = resourceId('res-abc');
const JID = jobId('job-xyz');

/** The job a `job:claimed` reply carries: what the dispatcher hands a worker. */
type ClaimedJob = EventMap['job:claimed']['response'];

/** Captured interactions — bus emits and the yield.resource call. A claim is the harness's own, and is not among them. */
interface BusEmit { channel: string; payload: unknown; scope?: string | undefined; }

function makeFakeWorker() {
  const busEmits: BusEmit[] = [];
  const yieldResourceCalls: Parameters<SemiontClient['yield']['resource']>[0][] = [];
  /** The stand-in dispatcher's queue: each `job:claim` is answered with the next of these, or with nothing pending. */
  const offered: ClaimedJob[] = [];
  /** Refusals the stand-in dispatcher answers the next claims with, before anything it has queued. */
  const refusals: EventMap['job:claim-failed'][] = [];
  /** Channels the gateway does not take: an emit on one fails, as it does when the gateway cannot be reached. */
  const failingEmits = new Set<string>();

  // The Archivist stand-in for the durability ack: a unit counts as complete
  // only once `mark:commit` has acknowledged its annotations as logged.
  // `mark:commit` is a request/reply operation, so the harness must answer
  // it or every unit blocks until the commit timeout. `commitSink` lets a test
  // play the sink being down.
  // Replies are FRAMES: `busRequest` matches on the envelope's key, so a
  // double that only carried payloads would let a key-dropping reply pass.
  const replyStreams = new Map<
    string,
    Subject<{ correlationId?: string; payload: Record<string, unknown> }>
  >();
  const replyStream = (channel: string) => {
    let s = replyStreams.get(channel);
    if (!s) { s = new Subject(); replyStreams.set(channel, s); }
    return s;
  };
  /**
   * The stand-in Archivist's disposition — and, separately, what the log holds
   * because of it. The two are not the same fact, and a job's outcome follows
   * the second:
   *
   *   ok         appended, acknowledged
   *   ack-lost   APPENDED, acknowledgement never routed
   *   silent     never arrived, so nothing appended, nothing answered
   *   fail       refused, nothing appended
   *
   * `ack-lost` and `silent` are indistinguishable to the worker's `busRequest`
   * — both are a `bus.timeout` — and they are opposite truths about the data.
   * Telling them apart is what the durability probe is for, so the fake must
   * be able to be each.
   */
  const commitSink: { mode: 'ok' | 'fail' | 'silent' | 'ack-lost' | 'first-ok-then-lost' } = { mode: 'ok' };
  let commitCount = 0;
  /** The event log's annotation set for RID, as the stand-in Archivist holds it. */
  const landed: Array<{ id: string }> = [];
  /** Whether the durability probe can be answered at all. */
  const probeSink: { mode: 'answer' | 'unreachable' } = { mode: 'answer' };

  const transportEmit = vi.fn(async (channel: string, payload: Record<string, unknown>, envelope?: { correlationId?: string; scope?: string }) => {
    if (channel === 'job:claim') {
      // Answered on the next tick, as a real dispatcher would.
      const correlationId = envelope?.correlationId as string;
      const refusal = refusals.shift();
      const record = refusal ? undefined : offered.shift();
      queueMicrotask(() => {
        if (record) replyStream('job:claimed').next({ correlationId, payload: { response: record } });
        else replyStream('job:claim-failed').next({ correlationId, payload: { ...(refusal ?? { message: 'No pending job matches', code: 'none-pending' }) } });
      });
      return 1;
    }
    if (failingEmits.has(channel)) throw new Error(`the gateway did not take ${channel}`);
    busEmits.push({ channel, payload, scope: envelope?.scope });
    if (channel === 'mark:commit') {
      commitCount++;
      const correlationId = envelope?.correlationId as string;
      const annotations = (payload.annotations ?? []) as Array<{ id: string }>;
      const mode = commitSink.mode === 'first-ok-then-lost'
        ? (commitCount === 1 ? 'ok' : 'ack-lost')
        : commitSink.mode;
      if (mode === 'ok' || mode === 'ack-lost') {
        // Appended idempotently by annotation id — the real Stower's contract,
        // whose `mark:commit` appends only what the log lacks. Modelling it
        // here keeps this fake from claiming a property the log does not have;
        // the double-SEND it cannot hide is asserted directly, by counting
        // `mark:commit` emits.
        for (const a of annotations) {
          if (!landed.some((l) => String(l.id) === String(a.id))) landed.push(a);
        }
      }
      // Answer on the next tick, as a real Archivist would — unless the reply
      // path is gone, which is both timeout modes.
      if (mode === 'ok' || mode === 'fail') {
        queueMicrotask(() => {
          if (mode === 'ok') {
            replyStream('mark:commit-ok').next({
              correlationId,
              payload: {
                response: { persisted: annotations.length, annotationIds: annotations.map((a) => String(a.id)) },
              },
            });
          } else {
            replyStream('mark:commit-failed').next({ correlationId, payload: { message: 'sink down' } });
          }
        });
      }
    }
    return 1;
  });
  const transport = {
    emit: transportEmit,
    stream: vi.fn((channel: string) =>
      replyStream(channel).asObservable().pipe(map((frame) => frame.payload)),
    ),
    frames: vi.fn((channel: string) => replyStream(channel).asObservable()),
    // 'open' is the attach gate's pass value; anything else holds every
    // busRequest until it times out.
    state$: new BehaviorSubject('open'),
    isSubscribed: () => true,
    trackReply: () => () => {},
  };
  const client = {
    transport,
    // The SDK's own namespace over the fake transport: `job.claim` here is the
    // real claiming, and the jobs it hands out are real held jobs.
    job: new JobNamespace(transport as unknown as ITransport, new EventBus()),
    browse: {
      // Detection jobs gate on the resource's media type before
      // fetching content; default to a text resource so the happy
      // paths proceed.
      resource: vi.fn((_rid: string) => ({
        fresh: async () => ({ representations: [{ mediaType: 'text/plain' }] }),
      })),
      // The Smelter's geometry consult. Only PDF tests take this path;
      // they override it. Default is a benign settled answer.
      resourceAnchoredText: vi.fn(async (_rid: string) => ({
        kind: 'extracted', text: 'the content', items: [], method: 'pdf-text-layer',
      })),
      // The durability probe. What the log actually holds — the only
      // evidence that can separate a lost acknowledgement from a lost batch.
      // Rejects when absent, as the real read does
      // (`browse:annotation-failed`, "Annotation not found").
      annotation: vi.fn((_rid: string, aid: string) => ({
        fresh: async () => {
          // `probeSink` plays the read being UNANSWERABLE, which is a
          // different fact from the read answering "no" — `bus.timeout`
          // versus `bus.rejected`, and opposite epistemic states.
          if (probeSink.mode === 'unreachable') {
            throw new BusRequestError('Bus request timed out after 30000ms on browse:annotation-result', 'bus.timeout');
          }
          const hit = landed.find((a) => String(a.id) === String(aid));
          if (!hit) throw new BusRequestError('Annotation not found', 'bus.rejected');
          return hit;
        },
      })),
    },
    yield: {
      resource: vi.fn(async (data: Parameters<SemiontClient['yield']['resource']>[0]) => {
        yieldResourceCalls.push(data);
        return { resourceId: 'new-res-42' };
      }),
    },
  } as unknown as SemiontClient;

  /** Hold `record`: the next claim is answered with it, and the job the SDK's claims hand out is returned. */
  const hold = (record: ClaimedJob): Promise<HeldJob> => new Promise((resolve, reject) => {
    offered.push(record);
    client.job.claim({ accepts: EVERYTHING }).subscribe({ next: resolve, error: reject });
  });
  /** Queue `record` and announce it, so a worker that holds nothing claims it. */
  const offer = (record: ClaimedJob): void => {
    offered.push(record);
    wake();
  };
  /** An announcement every worker here takes: an idle one claims. */
  const wake = (): void => {
    replyStream('job:queued').next({ payload: { jobId: 'job-announced', jobType: 'yield', resourceId: RID, userId: 'did:web:kb.example:users:u', params: {} } });
  };
  /** A cancellation naming `id`, as the gateway relays one. */
  const cancel = (id: string): void => {
    replyStream('job:cancel-requested').next({ payload: { jobId: id } });
  };
  /** How the jobs run here were settled, in order: each is one of job:complete, job:fail and job:cancel. */
  const settles = (): string[] => busEmits.map((e) => e.channel).filter((channel) => ['job:complete', 'job:fail', 'job:cancel'].includes(channel));

  return { client, hold, offer, wake, cancel, refusals, failingEmits, settles, busEmits, yieldResourceCalls, commitSink, landed, probeSink };
}

/** A worker that takes every job: one filter for each. */
const EVERYTHING: WorkerProcessConfig['accepts'] = [
  ...(['highlighting', 'commenting', 'assessing', 'linking', 'tagging'] as const).map((motivation) => ({ jobType: 'mark' as const, params: { motivation } })),
  { jobType: 'yield' },
];

/**
 * Run `record` as a job this worker holds. A `signal` stands for a
 * cancellation of it: when it aborts, the gateway relays one naming the job.
 */
async function handleHeld(
  h: ReturnType<typeof makeFakeWorker>,
  config: WorkerProcessConfig,
  record: ClaimedJob,
  completedUnitsByJob?: Map<string, string[]>,
  signal?: AbortSignal,
  unitCursorsByJob?: Map<string, Record<string, UnitCursor>>,
): Promise<void> {
  const job = await h.hold(record);
  if (signal?.aborted) h.cancel(job.jobId);
  else signal?.addEventListener('abort', () => h.cancel(job.jobId), { once: true });
  return handleJob(config, job, completedUnitsByJob, unitCursorsByJob);
}

/**
 * Stub a motivation processor: annotations leave through the awaited
 * chunk-commit callback (argument 5), the return carries only the result.
 */
const emitting = (r: { annotations: unknown[]; result: unknown; unit?: string }) =>
  (async (...args: unknown[]) => {
    // Typed with the checkpoint it actually takes: a looser
    // `(a: unknown[]) => …` cast keeps compiling when the seam's arguments
    // change, and the omission surfaces only at runtime as
    // "Cannot read properties of undefined (reading 'unit')".
    const onChunkComplete = args[5] as (a: unknown[], c: UnitCheckpoint) => Promise<void>;
    await onChunkComplete(r.annotations, { unit: r.unit ?? 'highlighting', cursor: { next: 900, size: 220, found: 0, emitted: 0, errors: 0 } });
    return { result: r.result } as never;
  }) as never;

function makeConfig(client: SemiontClient): WorkerProcessConfig {
  return {
    client,
    accepts: EVERYTHING,
    inferenceClient: {} as never,
    generator: {
      '@type': 'Software',
      '@id': 'did:web:example.com:agents:ollama:test',
      name: 'ollama test',
      provider: 'ollama',
      model: 'test',
    } as never,
    contentReads: { getBinary },
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(function(this: any){ return this; }) } as never,
  };
}

/** A job this worker runs, as these tests name one: a `mark` job by its motivation, or `yield`. */
type Runs = MarkMotivation | 'yield';

const TAG_SCHEMA = { id: 'irac', name: 'IRAC', description: 'Legal analysis', domain: 'legal', tags: [{ name: 'Issue', description: 'The question', examples: [] }] };

function makeJob(
  what: Runs,
  paramsOverride: Record<string, unknown> = {},
  completedUnits: string[] = [],
  // Default: no retries budgeted, so a failure is terminal unless a test
  // says otherwise — `willRetry` on `job:fail` is read from this budget.
  budget: { retryCount: number; maxRetries: number } = { retryCount: 0, maxRetries: 0 },
  /** Mid-unit resume positions from an earlier attempt. Empty is the
   * first-attempt case every test but the resume ones want. */
  unitCursors: Record<string, UnitCursor> = {},
): ClaimedJob {
  return {
    status: 'running',
    metadata: {
      id: JID,
      type: what === 'yield' ? 'yield' : 'mark',
      userId: userId('did:web:kb.example:users:u'),
      created: '2026-01-01T00:00:00.000Z',
      ...budget,
      // Both appear on the record once an attempt has checkpointed.
      ...(completedUnits.length > 0 ? { completedUnits } : {}),
      ...(Object.keys(unitCursors).length > 0 ? { unitCursors } : {}),
    },
    // What the Dispatcher hands over: the description's params and what it
    // adds. A yield job's must satisfy the wire's required trio (the worker
    // guard enforces it), and a tagging job comes with its schema resolved;
    // overrides still win.
    params: what === 'yield'
      ? { resourceId: RID, ...GEN_REQUIRED, ...paramsOverride }
      : {
        motivation: what,
        resourceId: RID,
        ...(what === 'tagging' ? { schemaId: TAG_SCHEMA.id, schema: TAG_SCHEMA, categories: ['Issue'] } : {}),
        ...paramsOverride,
      },
    startedAt: '2026-01-01T00:00:01.000Z',
    progress: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleJob orchestration', () => {

  // ── Annotation jobs — all five follow the same shape. Each suite asserts:
  //   (1) processor was called
  //   (2) leads with `job:start` carrying jobId + jobType
  //   (3) one awaited `mark:commit` per chunk, trailed by its `job:checkpoint`
  //   (4) exactly one `job:complete` emit carrying jobType + result
  //   (5) the held job settled exactly once, AFTER the above

  describe('highlighting', () => {
    it('forwards the progress CODE onto the wire — the producer says what, clients say it in their language', async () => {
      // The wire half of one rule: a progress event carries a code and typed
      // params, never prose. Dropping the argument is silent: every event
      // still flows, and the UI just has nothing to render.
      vi.mocked(processHighlightJob).mockImplementation(async (_c, _i, _p, _b, onProgress) => {
        onProgress(60, { code: 'creating-annotations', count: 2 });
        return { annotations: [], result: { found: 0, persisted: 0 } as never };
      });
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));

      const progressEvent = h.busEmits.find(e => e.channel === 'job:report-progress');
      expect(progressEvent).toBeDefined();
      expect((progressEvent!.payload as { progress: unknown }).progress).toMatchObject({
        percentage: 60,
        message: { code: 'creating-annotations', count: 2 },
      });
    });

    it('emits job:start, mark:commit and job:checkpoint per chunk, then job:complete', async () => {
      vi.mocked(processHighlightJob).mockImplementation(emitting({
        annotations: [{ id: 'a1' }, { id: 'a2' }] as never,
        result: { found: 2, persisted: 2 } as never,
      }));
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));

      expect(h.busEmits.map(e => e.channel))
        // A `job:checkpoint` trails every committed chunk, not only every
        // completed unit. For a one-unit job that is the ONLY checkpoint there
        // can be before the job ends: the unit grain alone is too coarse for
        // these four types.
        .toEqual(['job:start', 'mark:commit', 'job:checkpoint', 'job:complete']);
      expect(h.busEmits.find(e => e.channel === 'job:complete')!.payload)
        .toMatchObject({ jobType: 'mark', result: { found: 2 } });
      expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
    });

    it('cites the job on the mark:commit it persists with', async () => {
      // The worker holds the job; the write that fulfils it says so. Without
      // this the record cannot join the annotations back to who asked for
      // them, and a worker-role write with no citation is refused downstream.
      vi.mocked(processHighlightJob).mockImplementation(emitting({
        annotations: [{ id: 'a1' }] as never,
        result: { found: 1, persisted: 1 } as never,
      }));
      const h = makeFakeWorker();
      const job = makeJob('highlighting');

      await handleHeld(h, makeConfig(h.client), job);

      const commit = h.busEmits.find(e => e.channel === 'mark:commit');
      expect(commit).toBeDefined();
      expect((commit!.payload as { jobId?: string }).jobId).toBe(job.metadata.id);
    });
  });

  describe('commenting', () => {
    it('emits job:start, mark:commit and job:checkpoint per chunk, then job:complete', async () => {
      vi.mocked(processCommentJob).mockImplementation(emitting({
        annotations: [{ id: 'c1' }] as never,
        result: { found: 1, persisted: 1 } as never,
      }));
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('commenting'));

      expect(h.busEmits.map(e => e.channel))
        // A `job:checkpoint` trails every committed chunk, not only every
        // completed unit. For a one-unit job that is the ONLY checkpoint there
        // can be before the job ends: the unit grain alone is too coarse for
        // these four types.
        .toEqual(['job:start', 'mark:commit', 'job:checkpoint', 'job:complete']);
      expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
    });
  });

  describe('assessing', () => {
    it('emits job:start, mark:commit and job:checkpoint per chunk, then job:complete', async () => {
      vi.mocked(processAssessmentJob).mockImplementation(emitting({
        annotations: [{ id: 'a1' }] as never,
        result: { found: 1, persisted: 1 } as never,
      }));
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('assessing'));

      expect(h.busEmits.map(e => e.channel))
        // A `job:checkpoint` trails every committed chunk, not only every
        // completed unit. For a one-unit job that is the ONLY checkpoint there
        // can be before the job ends: the unit grain alone is too coarse for
        // these four types.
        .toEqual(['job:start', 'mark:commit', 'job:checkpoint', 'job:complete']);
      expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
    });
  });

  // The linking branch commits per chunk and checkpoints per
  // unit through `onUnitComplete` — covered by the 'checkpointed resume'
  // describes later in this file.

  describe('tagging', () => {
    it('emits job:start, mark:commit and job:checkpoint per chunk, then job:complete', async () => {
      vi.mocked(processTagJob).mockImplementation(emitting({
        annotations: [{ id: 't1' }] as never,
        result: { found: 1, persisted: 1 } as never,
      }));
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('tagging'));

      expect(h.busEmits.map(e => e.channel))
        // A `job:checkpoint` trails every committed chunk, not only every
        // completed unit. For a one-unit job that is the ONLY checkpoint there
        // can be before the job ends: the unit grain alone is too coarse for
        // these four types.
        .toEqual(['job:start', 'mark:commit', 'job:checkpoint', 'job:complete']);
      expect(h.busEmits.find(e => e.channel === 'job:complete')!.payload).toMatchObject({
        jobType: 'mark',
        result: { found: 1, persisted: 1 },
      });
      expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
    });
  });

  describe('yield', () => {
    it('uploads content via session.client.yield.resource, then emits job:complete with resourceId + resourceName', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('# Generated\n\nBody.'),
        title: 'New Resource',
        format: 'text/markdown',
        citations: [],
        truncated: true,
      });
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('yield', {
        context: minimalContext('annotation'),   // the focus IS the reference
        prompt: 'Write about X',
        language: 'en',
      }));

      // Verify the upload went through session.client.yield.resource
      // (not a raw fetch to /resources) with the expected fields.
      expect(h.yieldResourceCalls).toHaveLength(1);
      const uploaded = h.yieldResourceCalls[0]!;
      expect(uploaded.name).toBe('New Resource');
      expect(uploaded.format).toBe('text/markdown');
      expect(uploaded.sourceResourceId).toBe(RID);
      expect(uploaded.sourceAnnotationId).toBe('ann-1');   // derived from focus.annotation.id
      expect(uploaded.generationPrompt).toBe('Write about X');
      expect(uploaded.language).toBe('en');
      expect(uploaded.generator).toBeTruthy();

      // Bus emits: job:start then job:complete (no yield:create, no mark:commit).
      expect(h.busEmits.map(e => e.channel))
        .toEqual(['job:start', 'job:complete']);
      expect(h.busEmits.find(e => e.channel === 'job:complete')!.payload).toMatchObject({
        jobType: 'yield',
        // The worker states the result once the resource exists: its id from
        // the upload, its name and whether it was cut off from the processor.
        result: { resourceId: 'new-res-42', resourceName: 'New Resource', truncated: true },
      });
      expect(h.busEmits.map(e => e.channel)).not.toContain('yield:create');
      expect(h.busEmits.map(e => e.channel)).not.toContain('mark:commit');
      expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
    });

    // ── The Save location is authoritative ───────────────────────────────────
    // The form requires it, every layer carries it, and the worker uses it
    // verbatim. Deriving one from the title would put the artifact at
    // file://<title-slug><ext>, and RENAMING THE TITLE WOULD MOVE THE FILE.

    it('uploads to the storageUri the caller asked for, not a title-derived one', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('body'),
        title: 'A Long Descriptive Title',
        format: 'text/markdown',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('yield', {
        storageUri: 'file://research/notes.md',
      }));

      expect(h.yieldResourceCalls[0]!.storageUri).toBe('file://research/notes.md');
    });

    it('the title does not move the file — two titles, one requested uri', async () => {
      // The invariant: where the bytes land is the user's decision, not a
      // function of what they called the thing.
      const uris: Array<string | undefined> = [];
      for (const title of ['First Title', 'Totally Different Title']) {
        vi.mocked(processGenerationJob).mockResolvedValue({
          content: new TextEncoder().encode('body'),
          title,
          format: 'text/markdown',
          citations: [],
          truncated: false,
        });
        const h = makeFakeWorker();
        await handleHeld(h, makeConfig(h.client), makeJob('yield', {
          storageUri: 'file://research/notes.md',
        }));
        uris.push(h.yieldResourceCalls[0]!.storageUri);
      }

      expect(uris).toEqual(['file://research/notes.md', 'file://research/notes.md']);
    });

    it('an EMPTY storageUri fails the job and writes nothing — there is no fallback', async () => {
      // No `params.storageUri || deriveStorageUri(…)`: the form always
      // proposes a path, so a fallback could only hide a caller that forgot.
      // `required` means non-empty, enforced by the guard.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('body'),
        title: 'My Document',
        format: 'text/markdown',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();

      await expect(
        handleHeld(h, makeConfig(h.client), makeJob('yield', { storageUri: '' })),
      ).rejects.toThrow(/GenerationJobParams/);

      // "Fails" must mean NOTHING WAS WRITTEN — not merely that an error
      // surfaced after a resource already existed at a guessed path.
      expect(h.yieldResourceCalls).toHaveLength(0);
    });

    it('WARNS but does NOT refuse when the uri extension and the format disagree', async () => {
      // Validation belongs where the person who can fix it is standing —
      // the GUI refuses a mismatch; the worker is faithful and incurious. It
      // writes the requested bytes to the requested URI and says the pair
      // looks odd. Pinned explicitly because the `outputMediaType` gate a few
      // lines up (processors.ts) refuses, and a later reader will be tempted
      // to make this one refuse to match.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('%PDF-1.7'),
        title: 'Report',
        format: 'application/pdf',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();
      const config = makeConfig(h.client);

      await handleHeld(h, config, makeJob('yield', {
        storageUri: 'file://research/notes.md',
        outputMediaType: 'application/pdf',
      }));

      // Faithful: the requested URI is honored verbatim, and the job succeeds.
      expect(h.yieldResourceCalls[0]!.storageUri).toBe('file://research/notes.md');
      expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
      expect(h.settles().filter((how) => how === 'job:fail')).toHaveLength(0);

      // Loud: the warning names both halves of the disagreement.
      const warns = vi.mocked(config.logger.warn).mock.calls;
      const mismatch = warns.find(([msg]) => typeof msg === 'string' && /extension/i.test(msg));
      expect(mismatch, 'a format/extension mismatch is logged').toBeDefined();
      expect(JSON.stringify(mismatch![1])).toContain('application/pdf');
      expect(JSON.stringify(mismatch![1])).toContain('file://research/notes.md');
    });

    it('does not warn when the extension matches, case-insensitively', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('%PDF-1.7'),
        title: 'Report',
        format: 'application/pdf',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();
      const config = makeConfig(h.client);

      await handleHeld(h, config, makeJob('yield', {
        storageUri: 'file://research/NOTES.PDF',
        outputMediaType: 'application/pdf',
      }));

      const warns = vi.mocked(config.logger.warn).mock.calls;
      expect(warns.find(([msg]) => typeof msg === 'string' && /extension/i.test(msg))).toBeUndefined();
    });

    it('fails a generation job loudly when params do not satisfy the wire contract', async () => {
      // The guard is the trust boundary for params that crossed the wire as
      // untyped JSON — a trio-less bag must throw HERE, named, not surface as
      // a mid-generation TypeError. (Override wins over the factory's
      // GEN_REQUIRED injection.)
      const h = makeFakeWorker();

      await expect(
        handleHeld(h, makeConfig(h.client), makeJob('yield', { title: undefined }))
      ).rejects.toThrow(/params do not satisfy GenerationJobParams/);
      expect(processGenerationJob).not.toHaveBeenCalled();
    });

    it('propagates upload errors so the caller can translate to job:fail', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('body'),
        title: 'T',
        format: 'text/markdown',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();
      vi.mocked(h.client.yield.resource).mockRejectedValueOnce(new Error('Upload failed: 500'));

      await expect(
        handleHeld(h, makeConfig(h.client), makeJob('yield', { context: minimalContext('annotation') }))
      ).rejects.toThrow(/Upload failed: 500/);
    });

    it('forwards entityTypes from job params to the resource upload', async () => {
      // The worker is the last stop in the entityTypes pipeline; without
      // this forwarding step `browse.resources({ entityType: 'Character' })`
      // would never surface synthesized resources.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('body'),
        title: 'T',
        format: 'text/markdown',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();

      await handleHeld(
        h,
        makeConfig(h.client),
        makeJob('yield', {
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
        content: new TextEncoder().encode('body'),
        title: 'T',
        format: 'text/markdown',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('yield', { context: minimalContext('annotation') }));

      expect(h.yieldResourceCalls).toHaveLength(1);
      expect(h.yieldResourceCalls[0]!.entityTypes).toBeUndefined();
    });

    it('resource-focus generation (no referenceId) mints a source→derived reference annotation', async () => {
      // Annotation-focus generation auto-binds via sourceAnnotationId;
      // resource-focus has no triggering reference, so the worker mints a
      // navigable reference as the provenance link: target = the whole source
      // resource (resource-level, no selector), body = SpecificResource → the
      // derived resource.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('body'), title: 'Derived Doc', format: 'text/markdown', citations: [], truncated: false,
      });
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('yield', {}));

      expect(h.yieldResourceCalls[0]!.sourceAnnotationId).toBeUndefined(); // no auto-bind

      const commit = h.busEmits.find(e => e.channel === 'mark:commit');
      expect(commit, 'resource-focus generation mints a navigable source→derived reference').toBeDefined();
      const ann = (commit!.payload as { annotations: Array<{ target: { selector?: unknown } }> }).annotations[0]!;
      expect(ann).toMatchObject({
        motivation: 'linking',
        target: { source: RID },
        body: { type: 'SpecificResource', source: 'new-res-42', purpose: 'linking' },
      });
      // resource-level target — no selector
      expect(ann.target.selector).toBeUndefined();

      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:commit', 'job:complete']);
    });

    it('mints a linking annotation on the DERIVED resource for each resolved citation', async () => {
      // The processor resolved [[ctx-9]] into a claim-span citation; the worker
      // mints it after upload (only then is the derived resourceId known):
      // target = the derived resource + position/quote selectors for the claim,
      // body = SpecificResource → the cited source.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('Paris is the capital of France. It is large.'),
        title: 'Answer',
        format: 'text/markdown',
        citations: [{ resourceId: resourceId('ctx-9'), start: 0, end: 31, exact: 'Paris is the capital of France.' }],
        truncated: false,
      });
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('yield', { context: minimalContext('annotation'), cite: true }));

      // One commit per batch, so a per-annotation view is reconstructed:
      // each annotation paired with the resourceId its batch was keyed by.
      const markCreates = h.busEmits
        .filter(e => e.channel === 'mark:commit')
        .flatMap(e => {
          const p = e.payload as { resourceId: string; annotations: unknown[] };
          return p.annotations.map(annotation => ({ payload: { resourceId: p.resourceId, annotation } }));
        });
      expect(markCreates, 'one committed annotation per resolved citation').toHaveLength(1);
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
      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start', 'mark:commit', 'job:complete']);
    });

    it('anchors PDF citations by page geometry — FragmentSelector, never TextPositionSelector', async () => {
      // The citation offsets index the Typst SOURCE; on a PDF they render
      // nothing — the silent wrong this test exists to prevent. The worker
      // re-anchors each claim through the extracted text layer instead.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('%PDF-FAKE'),
        title: 'Answer',
        format: 'application/pdf',
        citations: [{ resourceId: resourceId('ctx-9'), start: 0, end: 31, exact: 'Paris is the capital of France.' }],
        truncated: false,
      });
      vi.mocked(extractPdfTextLayer).mockResolvedValue({
        text: 'Paris is the capital of France. It is large.',
        items: [{ start: 0, end: 44, page: 1, x: 71, y: 746, width: 450, height: 11 }],
        pages: [],
      } as never);
      const h = makeFakeWorker();

      await handleHeld(
        h,
        makeConfig(h.client),
        makeJob('yield', { context: minimalContext('annotation'), cite: true, outputMediaType: 'application/pdf' }),
      );

      // One commit per batch, so a per-annotation view is reconstructed:
      // each annotation paired with the resourceId its batch was keyed by.
      const markCreates = h.busEmits
        .filter(e => e.channel === 'mark:commit')
        .flatMap(e => {
          const p = e.payload as { resourceId: string; annotations: unknown[] };
          return p.annotations.map(annotation => ({ payload: { resourceId: p.resourceId, annotation } }));
        });
      expect(markCreates).toHaveLength(1);
      const payload = markCreates[0]!.payload as {
        resourceId: string;
        annotation: { motivation: string; target: { source: string; selector: Array<{ type: string }> }; body: unknown };
      };
      expect(payload.resourceId).toBe('new-res-42');
      expect(payload.annotation.motivation).toBe('linking');
      expect(payload.annotation.target.source).toBe('new-res-42');
      const selectorTypes = payload.annotation.target.selector.map((s) => s.type);
      expect(selectorTypes).toContain('FragmentSelector');
      expect(selectorTypes).toContain('TextQuoteSelector');
      expect(selectorTypes).not.toContain('TextPositionSelector');
      expect(payload.annotation.body).toMatchObject({ type: 'SpecificResource', source: 'ctx-9', purpose: 'linking' });
    });

    it('a hyphenated claim mints with the RENDERED text as its quote — the source string would trip the containment invariant', async () => {
      // The claim text comes from the Typst SOURCE; the rendered layer drops
      // the soft hyphen ("extraor" + "dinarily"). The quote selector must
      // carry what is actually under the rects — the rendered substring — or
      // buildPdfAnnotation's invariant throws and fails the whole job even
      // though findClaimSpan found the span.
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('%PDF-FAKE'),
        title: 'Answer',
        format: 'application/pdf',
        citations: [{ resourceId: resourceId('ctx-9'), start: 0, end: 27, exact: 'extraordinarily complicated' }],
        truncated: false,
      });
      vi.mocked(extractPdfTextLayer).mockResolvedValue({
        text: 'It is extraor \ndinarily complicated today.',
        items: [{ start: 0, end: 42, page: 1, x: 71, y: 764, width: 452, height: 11 }],
        pages: [],
      } as never);
      const h = makeFakeWorker();

      await handleHeld(
        h,
        makeConfig(h.client),
        makeJob('yield', { context: minimalContext('annotation'), cite: true, outputMediaType: 'application/pdf' }),
      );

      // One commit per batch, so a per-annotation view is reconstructed:
      // each annotation paired with the resourceId its batch was keyed by.
      const markCreates = h.busEmits
        .filter(e => e.channel === 'mark:commit')
        .flatMap(e => {
          const p = e.payload as { resourceId: string; annotations: unknown[] };
          return p.annotations.map(annotation => ({ payload: { resourceId: p.resourceId, annotation } }));
        });
      expect(markCreates).toHaveLength(1);
      const selector = (markCreates[0]!.payload as {
        annotation: { target: { selector: Array<{ type: string; exact?: string }> } };
      }).annotation.target.selector;
      const quote = selector.find(s => s.type === 'TextQuoteSelector');
      expect(quote?.exact).toBe('extraor \ndinarily complicated');
    });
  });

  describe('wire contract', () => {
    it('emits no field the channel does not declare', async () => {
      // `emitEvent` is typed `EventMap[K]`, but TypeScript suppresses
      // excess-property checking for spreads and for variables passed by
      // reference — so `{ ...lifecycleBase }` can carry an undeclared field
      // past the compiler: a `userId`, say, where only `_userId`
      // (gateway-injected) is declared. This pins the payload shapes so one
      // is caught here instead.
      vi.mocked(processHighlightJob).mockImplementation(emitting({
        annotations: [{ id: 'a1' }] as never,
        result: { found: 1, persisted: 1 } as never,
      }));
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));

      const keysOf = (channel: string) =>
        Object.keys(h.busEmits.find(e => e.channel === channel)!.payload as object).sort();

      // `attempt` rides every lifecycle payload including start — the queue can
      // re-run a job before it ever emits progress, so the first event must
      // already say which attempt it is.
      expect(keysOf('job:start')).toEqual(['attempt', 'jobId', 'jobType', 'resourceId']);
      // `job:start` stays bare: nothing has been committed yet, so there is no
      // durability to state. Every TERMINAL payload carries how durability was
      // established — here, an acknowledged commit.
      expect(keysOf('job:complete')).toEqual(['attempt', 'durability', 'jobId', 'jobType', 'resourceId', 'result']);
      // The commit carries a batch, the resource it targets, and the job it
      // fulfils — and NOTHING else. `jobId` is a DOMAIN fact: the record
      // derives who requested these annotations from that job's own events,
      // so the worker never names a requester. The correlation key busRequest
      // mints rides the envelope; its appearance here would mean a ROUTING
      // fact had leaked into a domain payload, which is what this pin
      // exists to catch.
      expect(keysOf('mark:commit')).toEqual(['annotations', 'jobId', 'resourceId']);
    });
  });

  // ── Every minting path is acknowledged ─────────────────────────────────────
  //
  // A path that emits `mark:create` fire-and-forget can lose its output: the
  // emit timeout (EMIT_TIMEOUT_MS) stops it HANGING, but an emit that
  // resolves means the gateway accepted the frame, not that the Stower
  // appended anything, so a down Archivist discards the output while the job
  // reports success.
  //
  // This is the census. It fails if any job type mints annotations without
  // waiting for the log.
  describe('no job type persists without an acknowledgement', () => {
    // TOTAL over the jobs a worker runs — each motivation of a mark job, and
    // yield — and that totality is the whole point. A hand-kept list of the
    // jobs that happened to exist when it was written does not fail when the
    // source grows. Typing the map `Record<Runs, Coverage>` makes a sixth
    // motivation a MISSING KEY and a removed one an EXCESS KEY, so either
    // fails `tsc --noEmit` before a single test runs.
    //
    // `coveredBy` is the deliberate escape hatch for a type this file's mocks
    // cannot observe. It still costs a key and a pointer, so an omission has to
    // be written down rather than simply not happening.
    type Coverage =
      | { exercise: Record<string, unknown>; commits: number; setup?: () => void }
      | { coveredBy: string };

    // Each case stubs its OWN processor. `vi.clearAllMocks()` clears calls but
    // KEEPS implementations, so without this the four detection cases would pass
    // on a `mockResolvedValue` leaked from an earlier test in the file — and an
    // un-stubbed processor returns undefined, whose empty batch `commitAnnotations`
    // correctly skips, so the census would assert against a job that never
    // minted anything. A gate that only holds when its neighbours run first is
    // not a gate.
    const minted = () => ({ annotations: [{ id: 'a1' }] as never, result: {} as never });

    const JOB_TYPE_COVERAGE: Record<Runs, Coverage> = {
      'highlighting':  { exercise: {}, commits: 1, setup: () => { vi.mocked(processHighlightJob).mockImplementation(emitting(minted())); } },
      'commenting':    { exercise: {}, commits: 1, setup: () => { vi.mocked(processCommentJob).mockImplementation(emitting(minted())); } },
      'assessing': { exercise: {}, commits: 1, setup: () => { vi.mocked(processAssessmentJob).mockImplementation(emitting(minted())); } },
      'tagging':        {
        exercise: { schema: { id: 's', name: 's', categories: [{ name: 'catA' }] } },
        commits: 1,
        setup: () => { vi.mocked(processTagJob).mockImplementation(emitting(minted())); },
      },

      // Generation mints on TWO resources — the provenance edge on the SOURCE,
      // the citations on the DERIVED — and `mark:commit` is keyed by a single
      // resourceId, so it is genuinely two commits. Resource focus (the fixture
      // default) is what mints the provenance edge; annotation focus auto-binds
      // the triggering reference instead and mints only the citations.
      'yield': {
        exercise: { cite: true },
        commits: 2,
        setup: () => {
          vi.mocked(processGenerationJob).mockResolvedValue({
            content: new TextEncoder().encode('Paris is the capital of France.'),
            title: 'Answer',
            format: 'text/markdown',
            citations: [{ resourceId: resourceId('ctx-9'), start: 0, end: 31, exact: 'Paris is the capital of France.' }],
            truncated: false,
          });
        },
      },

      // Not exercised in this census: its commit rides `onChunkComplete` inside
      // `processReferenceJob`, which this file mocks wholesale. It is pinned
      // where the callback actually runs.
      'linking': {
        coveredBy: 'processors.test.ts — the rejecting-sink and recovering-sink pins on onChunkComplete',
      },
    };

    type Exercised = Extract<Coverage, { exercise: Record<string, unknown> }>;
    const EXERCISED = Object.entries(JOB_TYPE_COVERAGE).filter(
      (entry): entry is [string, Exercised] => 'exercise' in entry[1],
    );

    it.each(EXERCISED)('%s commits rather than fire-and-forgets', async (jobType, coverage) => {
      coverage.setup?.();
      const h = makeFakeWorker();
      await handleHeld(h, makeConfig(h.client), makeJob(jobType as never, coverage.exercise));

      const channels = h.busEmits.map(e => e.channel);
      expect(channels, `${jobType} must not emit un-acknowledged mark:create`).not.toContain('mark:create');

      const commits = h.busEmits.filter(e => e.channel === 'mark:commit');
      expect(commits, `${jobType} must acknowledge every batch it mints`).toHaveLength(coverage.commits);

      // Each commit is keyed by ONE resourceId, so a job minting on N resources
      // owes N commits to N DISTINCT resources — trivially true at 1, and the
      // real pin for generation, whose provenance and citations land on
      // different resources and would silently collapse into one batch.
      const keyedTo = new Set(commits.map(e => (e.payload as { resourceId: string }).resourceId));
      expect(keyedTo.size).toBe(coverage.commits);

      // Durability precedes the success claim: a job:complete emitted before
      // the LAST commit resolved would report work that may never have landed.
      expect(channels.lastIndexOf('mark:commit')).toBeLessThan(channels.indexOf('job:complete'));
    });
  });

  describe('a job this worker cannot run', () => {
    // Such a job fails as deterministic: no second attempt changes what a
    // worker is configured for, or supplies a processor it lacks, so the
    // retry budget is not spent on one. It is thrown, like every other
    // deterministic failure here, and the caller fails the held job.
    it('starts, then refuses for good a job this worker is not configured for', async () => {
      const h = makeFakeWorker();
      const config: WorkerProcessConfig = { ...makeConfig(h.client), accepts: [{ jobType: 'yield' }] };

      const refused = await handleHeld(h, config, makeJob('highlighting')).catch((e: unknown) => e);

      expect(String(refused)).toContain('Worker not configured for job: mark (highlighting)');
      expect(classifyFailure(refused)).toBe('deterministic');
      // The lifecycle is well-formed: it starts, and settles nothing itself.
      expect(h.busEmits.map(e => e.channel)).toEqual(['job:start']);
      // A job that was not run is not counted as one that completed.
      expect(recordJobOutcome).toHaveBeenLastCalledWith({ jobType: 'mark', motivation: 'highlighting' }, 'failed', expect.any(Number));
    });

    it('refuses for good a job it has no processor for', async () => {
      // A tagging job handed over without the schema the Dispatcher resolves.
      const h = makeFakeWorker();

      const refused = await handleHeld(h, makeConfig(h.client), makeJob('tagging', { schema: undefined })).catch((e: unknown) => e);

      expect(String(refused)).toContain('No processor for job: mark (tagging)');
      expect(classifyFailure(refused)).toBe('deterministic');
      expect(h.settles(), 'the caller fails the held job').toEqual([]);
    });
  });

  describe('processor throws', () => {
    it('propagates the error (the caller fails the held job)', async () => {
      vi.mocked(processReferenceJob).mockRejectedValue(new Error('inference blew up'));
      const h = makeFakeWorker();

      await expect(
        handleHeld(h, makeConfig(h.client), makeJob('linking', { entityTypes: ['Person'] }))
      ).rejects.toThrow('inference blew up');

      // On failure, handleJob itself does NOT emit job:complete.
      // job:start still fires at entry; the outer wrapper emits job:fail.
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(false);
      expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(0);
    });
  });

  // ── Detection media-type gate ────────────────────────────────────────
  // A media type with no text source (`textSourceOf` is 'none' — a zip, an
  // image) can never yield text to detect over. `prepareDetection` declines
  // it on the resource's primary media type before reading any bytes, and
  // the job fails as a user error.

  describe('detection media-type gate', () => {
    it('fails a detection job on a binary resource before fetching content or calling the processor', async () => {
      const h = makeFakeWorker();
      vi.mocked(h.client.browse.resource).mockReturnValue({
        fresh: async () => ({ representations: [{ mediaType: 'application/zip' }] }),
      } as never);

      await expect(
        handleHeld(h, makeConfig(h.client), makeJob('linking', { entityTypes: ['Person'] }))
      ).rejects.toThrow(/has no extractable text/);

      expect(getBinary).not.toHaveBeenCalled();
      expect(processReferenceJob).not.toHaveBeenCalled();
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(false);
    });

    // All five detection motivations fan out to the PDF
    // text-layer path. Geometry is shared (buildPdfAnnotation, covered in
    // build-pdf-annotation.test.ts); this proves the dispatch routes every
    // motivation through 'pdf-text-layer' — feeding each processor the extracted
    // layer text (arg 0) and a PDF-aware buildAnnotation (arg 3), never the
    // decoded-bytes path. `lastCall` closes over the concrete mock so each
    // processor's own arg tuple is read (their signatures differ).
    type PdfFanoutCase = {
      jobType: MarkMotivation;
      arm: () => void;                    // set this processor's resolved value
      lastCall: () => unknown[] | undefined;
    };
    const PDF_FANOUT: PdfFanoutCase[] = [
      { jobType: 'highlighting',
        arm: () => { vi.mocked(processHighlightJob).mockImplementation(emitting({ annotations: [] as never, result: {} as never })); },
        lastCall: () => vi.mocked(processHighlightJob).mock.calls[0] },
      { jobType: 'commenting',
        arm: () => { vi.mocked(processCommentJob).mockImplementation(emitting({ annotations: [] as never, result: {} as never })); },
        lastCall: () => vi.mocked(processCommentJob).mock.calls[0] },
      { jobType: 'assessing',
        arm: () => { vi.mocked(processAssessmentJob).mockImplementation(emitting({ annotations: [] as never, result: {} as never })); },
        lastCall: () => vi.mocked(processAssessmentJob).mock.calls[0] },
      { jobType: 'linking',
        arm: () => { vi.mocked(processReferenceJob).mockResolvedValue({ result: {} as never }); },
        lastCall: () => vi.mocked(processReferenceJob).mock.calls[0] },
      { jobType: 'tagging',
        arm: () => { vi.mocked(processTagJob).mockImplementation(emitting({ annotations: [] as never, result: {} as never })); },
        lastCall: () => vi.mocked(processTagJob).mock.calls[0] },
    ];

    it.each(PDF_FANOUT)('fans $jobType out to the geometry-consult path', async ({ jobType, arm, lastCall }) => {
      arm();
      const h = makeFakeWorker();
      vi.mocked(h.client.browse.resource).mockReturnValue({
        fresh: async () => ({
        representations: [{ mediaType: 'application/pdf' }],
      }),
      } as never);
      // Geometry text comes from the Smelter consult, not extract.
      vi.mocked(h.client.browse.resourceAnchoredText).mockResolvedValue({
        kind: 'extracted', text: 'the quick brown fox', items: [], method: 'pdf-text-layer',
      } as never);

      await handleHeld(
        h,
        makeConfig(h.client),
        // The reference branch reads entityTypes before dispatching to the
        // (mocked) processor — give it the params a real job always carries.
        makeJob(jobType, jobType === 'linking' ? { entityTypes: ['Person'] } : {}),
      );

      // A PDF is geometry-bearing: its text comes from the CONSULT, not from
      // fetching and re-extracting bytes here. getBinary must NOT run — a 39 MB
      // download whose bytes are discarded still downloads.
      expect(h.client.browse.resourceAnchoredText).toHaveBeenCalled();
      expect(getBinary).not.toHaveBeenCalled();
      const call = lastCall();
      expect(call).toBeDefined();
      expect(call![0]).toBe('the quick brown fox'); // source.text — the consulted canonical text
      expect(typeof call![3]).toBe('function');      // source.buildAnnotation — PDF-aware anchor
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(true);
    });

    it('declines cleanly (no throw, no processor) for a scanned PDF with no text layer', async () => {
      // A genuine content decline comes back from the CONSULT by name: the
      // Smelter tried and settled skipped. The dispatch completes the job with
      // that reason rather than crashing or running the model on nothing.
      const h = makeFakeWorker();
      vi.mocked(h.client.browse.resource).mockReturnValue({
        fresh: async () => ({
        representations: [{ mediaType: 'application/pdf' }],
      }),
      } as never);
      vi.mocked(h.client.browse.resourceAnchoredText).mockResolvedValue({
        kind: 'declined', declined: 'no-text-layer',
      } as never);

      await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));

      expect(processHighlightJob).not.toHaveBeenCalled();
      const complete = h.busEmits.find(e => e.channel === 'job:complete');
      expect(complete).toBeDefined();
      expect((complete!.payload as { result?: unknown }).result)
        .toMatchObject({ declined: true, reason: 'no-text-layer' });
      expect(h.settles()).toEqual(['job:complete']);
    });

    it('a not-yet consult is a TRANSIENT failure — the retry finds the store warm', async () => {
      // The Smelter has not settled this generation yet. Not a decline, not a
      // clean completion — a retryable failure. The throw carries no
      // deterministic class, so classifyFailure leaves it transient.
      const h = makeFakeWorker();
      vi.mocked(h.client.browse.resource).mockReturnValue({
        fresh: async () => ({ representations: [{ mediaType: 'application/pdf' }] }),
      } as never);
      vi.mocked(h.client.browse.resourceAnchoredText).mockResolvedValue({ kind: 'not-yet' } as never);

      const err = await handleHeld(h, makeConfig(h.client), makeJob('highlighting'))
        .then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not yet derived/);
      expect(classifyFailure(err)).toBeUndefined();   // transient — retryable
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(false);
      expect(processHighlightJob).not.toHaveBeenCalled();
    });

    it('a no-map consult is a TERMINAL failure — drift the retry cannot fix', async () => {
      const h = makeFakeWorker();
      vi.mocked(h.client.browse.resource).mockReturnValue({
        fresh: async () => ({ representations: [{ mediaType: 'application/pdf' }] }),
      } as never);
      vi.mocked(h.client.browse.resourceAnchoredText).mockResolvedValue({ kind: 'no-map' } as never);

      const err = await handleHeld(h, makeConfig(h.client), makeJob('highlighting'))
        .then(() => null, (e) => e);
      expect((err as Error).message).toMatch(/consult returned 'no-map'/);
      expect(classifyFailure(err)).toBe('deterministic');   // terminal
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(false);
    });

    it('fails a detection job when the resource has no primary representation', async () => {
      const h = makeFakeWorker();
      vi.mocked(h.client.browse.resource).mockReturnValue({
        fresh: async () => ({
        representations: [],
      }),
      } as never);

      await expect(
        handleHeld(h, makeConfig(h.client), makeJob('commenting'))
      ).rejects.toThrow(/has no extractable text/);

      expect(getBinary).not.toHaveBeenCalled();
    });

    it('proceeds for a registry-miss text subtype (RFC 2046 fallback)', async () => {
      // Imported content can carry unregistered text/* types — the
      // import-leniency invariant. They decode, so detection runs.
      vi.mocked(processCommentJob).mockImplementation(emitting({
        annotations: [] as never,
        result: { found: 0, persisted: 0 } as never,
      }));
      const h = makeFakeWorker();
      vi.mocked(h.client.browse.resource).mockReturnValue({
        fresh: async () => ({
        representations: [{ mediaType: 'text/x-custom' }],
      }),
      } as never);

      await handleHeld(h, makeConfig(h.client), makeJob('commenting'));

      expect(processCommentJob).toHaveBeenCalled();
      expect(h.busEmits.some(e => e.channel === 'job:complete')).toBe(true);
    });

    it('does not gate generation jobs (they read the annotation, not the source bytes)', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: new TextEncoder().encode('body'),
        title: 'T',
        format: 'text/markdown',
        citations: [],
        truncated: false,
      });
      const h = makeFakeWorker();

      await handleHeld(h, makeConfig(h.client), makeJob('yield', { context: minimalContext('annotation') }));

      expect(h.client.browse.resource).not.toHaveBeenCalled();
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
// `resourceId`. There is no resource-scoped copy. All channels emit globally
// with no scope.
// ──────────────────────────────────────────────────────────────────────

describe('handleJob — global job-completion', () => {
  it('emits job:complete exactly once, globally (no scope)', async () => {
    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [] as never,
      result: {} as never,
    }));
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));

    const completes = h.busEmits.filter(e => e.channel === 'job:complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]!.scope).toBeUndefined();
  });

  it('emits job:start globally (no scope — not a resource broadcast)', async () => {
    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [] as never,
      result: {} as never,
    }));
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));

    const startEmit = h.busEmits.find(e => e.channel === 'job:start');
    expect(startEmit).toBeDefined();
    expect(startEmit!.scope).toBeUndefined();
  });

  it('emits mark:commit globally (the commit request is not a resource broadcast)', async () => {
    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [{ id: 'a1' }] as never,
      result: {} as never,
    }));
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));

    const commitEmit = h.busEmits.find(e => e.channel === 'mark:commit');
    expect(commitEmit).toBeDefined();
    // Global, not resource-scoped: the reply has to reach the awaiting worker.
    expect(commitEmit!.scope).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// startWorkerProcess — the outer wrapper that claims jobs (`job.claim`),
// runs each one it comes to hold, and fails a held job whose run rejects.
// ──────────────────────────────────────────────────────────────────────

describe('startWorkerProcess', () => {
  // Nothing is mocked between the worker and the wire: the SDK's own claiming
  // runs over the fake transport, and the stand-in dispatcher answers each
  // `job:claim` with what a test offered, refused, or with nothing pending.

  // The cancel SIGNAL's routing, distinct from what the loop does once aborted.
  // A worker holds one active job; a `job:cancel-requested` naming a different
  // one must not touch it. Getting this wrong cancels a stranger's work, and
  // the failure is invisible — the wrong job simply stops.
  it('aborts the active job only when the cancel names it', async () => {

    let seenSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    vi.mocked(processReferenceJob).mockImplementation(
      async (_c, _cl, _p, _b, _pr, _l, _onUnit, signal) => {
        seenSignal = signal;
        await new Promise<void>((r) => { release = r; });
        return { result: { found: 0, persisted: 0 } as never };
      },
    );

    const h = makeFakeWorker();
    startWorkerProcess(makeConfig(h.client));
    h.offer(makeJob('linking', { entityTypes: ['Person'] }));
    await vi.waitFor(() => expect(seenSignal).toBeDefined());

    // A cancel for some other job leaves this one running.
    h.cancel('some-other-job');
    expect(seenSignal!.aborted).toBe(false);

    // A cancel naming the active job aborts it.
    h.cancel(JID);
    expect(seenSignal!.aborted).toBe(true);

    release?.();
  });

  // The refusal policy: a claim refused because this credential is not a
  // worker's can never succeed, so the process exits for restart rather than
  // parking forever, refused on every wake-up, with nothing in its own logs
  // saying why. Any other refusal is logged and the worker stays parked until
  // the next wake-up.
  it('exits on a claim refused as unauthorized, and only logs any other refusal', async () => {
    const h = makeFakeWorker();
    const exit = vi.fn();
    const config = { ...makeConfig(h.client), exit };
    h.refusals.push({ message: 'the queue could not be read' });
    startWorkerProcess(config);
    await new Promise((r) => setTimeout(r, 0));

    expect(config.logger.warn).toHaveBeenCalledWith('Claim declined; parked until the next wake-up', { code: 'bus.rejected', message: 'the queue could not be read' });
    expect(exit, 'a refusal that may not recur parks the worker; it does not kill it').not.toHaveBeenCalled();

    h.refusals.push({ code: 'unauthorized', message: 'job:claim refused: the caller is not a worker for this knowledge base' });
    h.wake();
    await new Promise((r) => setTimeout(r, 0));
    expect(exit).toHaveBeenCalledWith(1);
  });

  // A held job that shows no activity is wedged, and a wedged worker never
  // settles, so it never claims again. The SDK reports the stall
  // (`heldJobStallMs`, looked at every `heldJobStallCheckMs`); what a host
  // does then is the host's, and this one exits for restart.
  it('exits when the job it holds stalls', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(processHighlightJob).mockImplementation(() => new Promise(() => {}));
      const h = makeFakeWorker();
      const exit = vi.fn();
      const config = { ...makeConfig(h.client), exit };
      h.offer(makeJob('highlighting'));
      startWorkerProcess(config);

      await vi.advanceTimersByTimeAsync(HELD_JOB_STALL_MS - 1_000);
      expect(exit, 'silent for less than the threshold').not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(HELD_JOB_STALL_CHECK_MS + 1_000);
      expect(exit).toHaveBeenCalledWith(1);
      expect(config.logger.error).toHaveBeenCalledWith('Worker stalled — exiting for restart', expect.objectContaining({ jobId: JID, thresholdMs: HELD_JOB_STALL_MS }));
    } finally {
      vi.useRealTimers();
    }
  });

  // A completion that could not be sent has still released the job, and the
  // worker has nothing more to say of it: a `job:fail` after it would be a
  // second settle of one job.
  it('does not fail a job whose completion the gateway did not take', async () => {
    vi.mocked(processHighlightJob).mockImplementation(emitting({ annotations: [] as never, result: { found: 0, persisted: 0 } as never }));
    const h = makeFakeWorker();
    h.failingEmits.add('job:complete');
    const config = makeConfig(h.client);
    h.offer(makeJob('highlighting'));
    startWorkerProcess(config);
    await new Promise((r) => setTimeout(r, 10));

    expect(h.settles(), 'nothing it tried to say reached the wire, and it did not try a second settle').toEqual([]);
    expect(config.logger.error).toHaveBeenCalledWith('Job failed', expect.objectContaining({ jobId: JID, error: 'the gateway did not take job:complete' }));
  });

  it('claims, and runs each job it comes to hold', async () => {

    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [] as never,
      result: {} as never,
    }));

    const h = makeFakeWorker();
    startWorkerProcess(makeConfig(h.client));

    // The dispatcher has a job for this worker: it claims it and runs it.
    h.offer(makeJob('highlighting'));
    // Let handleJob's async chain settle.
    await new Promise((r) => setTimeout(r, 0));

    // handleJob emitted job:start → job:complete on the fake session.
    expect(h.busEmits.map((e) => e.channel)).toContain('job:start');
    expect(h.busEmits.map((e) => e.channel)).toContain('job:complete');

  });

  it('fails the held job when handleJob rejects', async () => {

    vi.mocked(processReferenceJob).mockRejectedValueOnce(new Error('inference blew up'));

    const h = makeFakeWorker();
    startWorkerProcess(makeConfig(h.client));

    h.offer(makeJob('linking', { entityTypes: ['Person'] }));
    await new Promise((r) => setTimeout(r, 10));

    // The outer handler fails the held job, which says job:fail on the bus.
    // job:fail is a global, jobId-keyed signal — emitted once, no resource scope.
    const failEmits = h.busEmits.filter((e) => e.channel === 'job:fail');
    expect(failEmits).toHaveLength(1);
    const failEmit = failEmits[0]!;
    expect(failEmit.scope).toBeUndefined();
    expect(failEmit.payload).toMatchObject({
      jobId: JID,
      jobType: 'mark',
      error: 'inference blew up',
      // The failure reports whether it is the END.
      // makeJob's default budget is 0/0, so this one is terminal — a client
      // watching the job may close its stream here.
      willRetry: false,
    });
    // A mark job is attached to no annotation.
    expect(failEmit.payload).not.toHaveProperty('annotationId');

  });

  it('reports willRetry:true when the budget still has room — the failure is not the end', async () => {
    vi.mocked(processReferenceJob).mockRejectedValueOnce(new Error('transient blip'));

    const h = makeFakeWorker();
    startWorkerProcess(makeConfig(h.client));

    // A first attempt with one retry budgeted — the queue WILL re-queue this.
    // `entityTypes` matters: without it the processor is never invoked, the
    // queued rejection is never consumed, and it leaks into a later test.
    h.offer(
      makeJob('linking', { entityTypes: ['Person'] }, [], { retryCount: 0, maxRetries: 1 }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const failEmit = h.busEmits.find((e) => e.channel === 'job:fail')!;
    expect(failEmit.payload).toMatchObject({ jobId: JID, willRetry: true });

  });

  // A job this worker cannot run fails as deterministic. So the wire says
  // the failure is the end, whatever is left of the record's retry budget:
  // a second attempt would be handed to a worker that cannot run it either.
  it('fails a job it is not configured for as deterministic: said on the wire, and not retried', async () => {
    const h = makeFakeWorker();
    startWorkerProcess({ ...makeConfig(h.client), accepts: [{ jobType: 'yield' }] });

    // One retry is budgeted, and is not spent.
    h.offer(makeJob('highlighting', {}, [], { retryCount: 0, maxRetries: 1 }));
    await new Promise((r) => setTimeout(r, 10));

    expect(h.busEmits.map((e) => e.channel)).toEqual(['job:start', 'job:fail']);
    expect(h.busEmits[1]!.payload).toMatchObject({
      jobId: JID,
      error: 'Worker not configured for job: mark (highlighting)',
      failureClass: 'deterministic',
      willRetry: false,
    });
  });
});

// ── Checkpointed resume ───────────────────────────────────────────────
// The worker owns durability: the chunk-commit callback is the effect (per
// chunk), `onUnitComplete` the control state (per unit); completed unit names
// ride job:fail, and a retried claim skips them.
//
// The commit is one acknowledged batch per chunk, not N fire-and-forget
// creates: the unit may not count until its annotations are durably in the
// event log.

describe('linking — checkpointed resume', () => {
  it('commits once per unit, awaiting durability, with no post-run re-emission', async () => {
    vi.mocked(processReferenceJob).mockImplementation(
      async (_content, _client, _params, _build, _progress, _logger, onUnitComplete, _signal, onChunkComplete) => {
        await onChunkComplete!([{ id: 'r1' }] as never, { unit: 'Person', cursor: { next: 900, size: 220, found: 0, emitted: 0, errors: 0 } });
        await onUnitComplete('Person');
        await onUnitComplete('Date'); // empty unit: nothing to commit, still checkpoints
        await onChunkComplete!([{ id: 'r2' }, { id: 'r3' }] as never, { unit: 'Location', cursor: { next: 1_800, size: 330, found: 0, emitted: 0, errors: 0 } });
        await onUnitComplete('Location');
        return { result: { found: 3, persisted: 3 } as never };
      },
    );
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), makeJob('linking', { entityTypes: ['Person', 'Date', 'Location'] }));

    // Exactly the callback's emissions, in unit order: ONE mark:commit per
    // non-empty unit, each followed by a durable job:checkpoint, persisted as
    // the unit completes so a crash recovers with it recorded. Date commits
    // nothing — there is nothing to make durable — but still checkpoints,
    // because an empty unit is complete and a retry must skip it. Nothing is
    // re-emitted after the processor returns.
    expect(h.busEmits.map(e => e.channel))
      .toEqual([
        'job:start',
        // Two checkpoints per non-empty unit: one trailing the chunk's
        // commit (the mid-unit cursor), one at the unit boundary (the unit is
        // complete and drops its cursor).
        'mark:commit', 'job:checkpoint', 'job:checkpoint',  // Person (1 annotation)
        'job:checkpoint',                                    // Date (empty unit, no commit)
        'mark:commit', 'job:checkpoint', 'job:checkpoint',  // Location (2 annotations, ONE batch)
        'job:complete',
      ]);

    // The batch is the unit: Location's two annotations travel together, so
    // the acknowledgement covers the unit rather than its parts.
    const commits = h.busEmits.filter(e => e.channel === 'mark:commit');
    expect(commits.map(c => (c.payload as { annotations: unknown[] }).annotations.length)).toEqual([1, 2]);
    // Each checkpoint carries the cumulative completed-unit set, so recovery
    // after a crash between any two units resumes from the right place. The
    // chunk-grain checkpoints sit BEFORE their unit joins the set — a chunk
    // being durable is not its unit being finished.
    const checkpoints = h.busEmits.filter(e => e.channel === 'job:checkpoint')
      .map(e => e.payload as { completedUnits: string[]; unitCursors?: Record<string, { next: number; size: number }> });
    expect(checkpoints.map(c => c.completedUnits)).toEqual([
      [],                                  // Person's chunk committed; the unit is still open
      ['Person'],                          // Person complete
      ['Person', 'Date'],                  // Date complete (empty unit)
      ['Person', 'Date'],                  // Location's chunk committed
      ['Person', 'Date', 'Location'],      // Location complete
    ]);
    // And the cursor appears while its unit is open, then goes ABSENT when the
    // unit completes: "partway here" and "finished" are never both true, and
    // absent is the honest encoding of "nothing is partway" — an empty object
    // would claim units were tracked and none had progress.
    expect(checkpoints.map(c => c.unitCursors)).toEqual([
      { Person: { next: 900, size: 220, found: 0, emitted: 0, errors: 0 } },
      undefined,
      undefined,
      { Location: { next: 1_800, size: 330, found: 0, emitted: 0, errors: 0 } },
      undefined,
    ]);
    expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
  });

  it('hands the claimed cursors to the processor so a partway unit resumes', async () => {
    // The last link: the checkpoint makes the cursor durable and the claim
    // hands it back, but a worker that never passes it on leaves the retry
    // restarting from the top with the record showing a resume that never
    // happened.
    let seen: unknown;
    vi.mocked(processReferenceJob).mockImplementation(
      (async (...args: unknown[]) => {
        seen = args[9];
        return { result: { found: 0, persisted: 0 } } as never;
      }) as never,
    );
    const h = makeFakeWorker();
    const cursors = { Person: { next: 12_400, size: 560, found: 0, emitted: 0, errors: 0 } };

    await handleHeld(
      h, makeConfig(h.client),
      makeJob('linking', { entityTypes: ['Person'] }, [], { retryCount: 1, maxRetries: 3 }, cursors),
    );

    expect(seen).toEqual(cursors);
  });

  it('hands the claimed cursors to a motivation processor too', async () => {
    // Four of the five types go through a different branch; wiring only the
    // reference one would leave them silently restarting.
    let seen: unknown;
    vi.mocked(processHighlightJob).mockImplementation(
      (async (...args: unknown[]) => {
        seen = args[6];
        return { result: { found: 0, persisted: 0 } } as never;
      }) as never,
    );
    const h = makeFakeWorker();
    const cursors = { highlighting: { next: 8_000, size: 400, found: 0, emitted: 0, errors: 0 } };

    await handleHeld(
      h, makeConfig(h.client),
      makeJob('highlighting', {}, [], { retryCount: 1, maxRetries: 3 }, cursors),
    );

    expect(seen).toEqual(cursors);
  });

  it('cancellation stops at a unit boundary: emits job:cancel with the checkpoint, not job:complete', async () => {
    // The signal is aborted (a cancel was requested for this job). The real
    // processReferenceJob breaks its loop at the next unit boundary; the mock
    // commits one unit and returns. handleJobInner must then announce
    // job:cancel — carrying the committed unit — instead of job:complete, so
    // the queue moves the still-running job to cancelled/ rather than mark it
    // done, and never fails it.
    vi.mocked(processReferenceJob).mockImplementation(
      async (_content, _client, _params, _build, _progress, _logger, onUnitComplete, _signal, onChunkComplete) => {
        await onChunkComplete!([{ id: 'r1' }] as never, { unit: 'Person', cursor: { next: 900, size: 220, found: 0, emitted: 0, errors: 0 } });
        await onUnitComplete('Person');
        return { result: { found: 1, persisted: 1 } as never };
      },
    );
    const h = makeFakeWorker();
    const controller = new AbortController();
    controller.abort();

    await handleHeld(
      h,
      makeConfig(h.client),
      makeJob('linking', { entityTypes: ['Person', 'Location'] }),
      new Map(),
      controller.signal,
    );

    const channels = h.busEmits.map(e => e.channel);
    expect(channels).toContain('job:cancel');
    expect(channels).not.toContain('job:complete');
    const cancel = h.busEmits.find(e => e.channel === 'job:cancel');
    expect((cancel!.payload as { completedUnits: string[] }).completedUnits).toEqual(['Person']);
    expect(h.settles().filter((how) => how !== 'job:fail')).toHaveLength(1);
  });

  it('a retried claim skips checkpointed units — the processor never sees them', async () => {
    vi.mocked(processReferenceJob).mockImplementation(
      async () => ({ result: { found: 0, persisted: 0 } as never }),
    );
    const h = makeFakeWorker();

    await handleHeld(
      h,
      makeConfig(h.client),
      makeJob('linking', { entityTypes: ['Person', 'Date', 'Location'] }, ['Person', 'Date']),
    );

    const params = vi.mocked(processReferenceJob).mock.calls[0]![2] as { entityTypes: unknown[] };
    expect(params.entityTypes.map(String)).toEqual(['Location']);
  });
});

describe('startWorkerProcess — job:fail carries the checkpoint', () => {
  it('accumulates committed units and puts them on the job:fail payload', async () => {

    // Two units commit, then the third stalls — the failure payload must
    // name what completed so the retry can skip it.
    vi.mocked(processReferenceJob).mockImplementation(
      async (_content, _client, _params, _build, _progress, _logger, onUnitComplete, _signal, onChunkComplete) => {
        await onChunkComplete!([{ id: 'a1' }] as never, { unit: 'Person', cursor: { next: 900, size: 220, found: 0, emitted: 0, errors: 0 } });
        await onUnitComplete('Person');
        await onUnitComplete('Date');
        throw new Error('Location stalled');
      },
    );

    const h = makeFakeWorker();
    startWorkerProcess(makeConfig(h.client));

    h.offer(makeJob('linking', { entityTypes: ['Person', 'Date', 'Location'] }));
    await new Promise((r) => setTimeout(r, 10));

    const failEmit = h.busEmits.find((e) => e.channel === 'job:fail');
    expect(failEmit).toBeDefined();
    expect(failEmit!.payload).toMatchObject({
      jobId: JID,
      error: 'Location stalled',
      completedUnits: ['Person', 'Date'],
    });

  });
});

describe('startWorkerProcess — job:fail carries the failure class', () => {
  it('a provider request-rejection is classified deterministic on the payload', async () => {

    // The SDK shape for "your request is the problem": an Error carrying a
    // 4xx status. Attempt 2 of this exact request cannot succeed.
    vi.mocked(processReferenceJob).mockRejectedValueOnce(
      Object.assign(new Error('request exceeds size limits'), { status: 413 }),
    );

    const h = makeFakeWorker();
    startWorkerProcess(makeConfig(h.client));

    h.offer(makeJob('linking', { entityTypes: ['Person'] }));
    await new Promise((r) => setTimeout(r, 10));

    const failEmit = h.busEmits.find((e) => e.channel === 'job:fail');
    expect(failEmit).toBeDefined();
    expect(failEmit!.payload).toMatchObject({
      jobId: JID,
      error: 'request exceeds size limits',
      failureClass: 'deterministic',
    });

  });
});

describe('a lost acknowledgement is not a lost batch', () => {
  // If the gateway goes down after the Archivist has appended a batch, the
  // acknowledgement cannot route, and 60 s later the commit reports
  //
  //     Bus request timed out after 60000ms on mark:commit-ok
  //
  // Nothing is lost, and a job that failed on that would be simply wrong — a
  // user cannot tell it apart from total loss, which after an hour of paid
  // inference is the whole problem.
  //
  // The outcome must follow whether the WORK LANDED, not whether a MESSAGE
  // arrived. Both facts are available: the annotations are addressable by
  // their own (content-derived) ids.

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Drive `handleJob` past `MARK_COMMIT_TIMEOUT_MS` without waiting a real minute. */
  async function runPastCommitTimeout(h: ReturnType<typeof makeFakeWorker>) {
    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [{ id: 'a1' }, { id: 'a2' }] as never,
      result: { found: 2, persisted: 2 } as never,
    }));
    const run = handleHeld(h, makeConfig(h.client), makeJob('highlighting'));
    const settled = run.then(() => 'completed' as const, (e) => e as Error);
    await vi.advanceTimersByTimeAsync(61_000);
    return settled;
  }

  it('reports SUCCESS when the annotations are durable and only the ack was lost', async () => {
    const h = makeFakeWorker();
    h.commitSink.mode = 'ack-lost';

    const outcome = await runPastCommitTimeout(h);

    // The batch is in the log — that is the fact the outcome owes its answer to.
    expect(h.landed.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(outcome, `job reported failure over durable data: ${outcome instanceof Error ? outcome.message : ''}`)
      .toBe('completed');
    expect(h.busEmits.map((e) => e.channel)).toContain('job:complete');
    expect(h.busEmits.map((e) => e.channel)).not.toContain('job:fail');
  });

  it('still FAILS when the batch never landed — the probe must not launder a real loss', async () => {
    // The guard on the probe. `silent` and `ack-lost` are the same timeout to the
    // worker and opposite truths about the data; a probe that answered "durable"
    // for both would convert a false failure into a false SUCCESS,
    // which is the defect the acknowledgement exists to prevent.
    const h = makeFakeWorker();
    h.commitSink.mode = 'silent';

    const outcome = await runPastCommitTimeout(h);

    expect(h.landed).toEqual([]);
    expect(outcome).toBeInstanceOf(Error);
    expect(h.busEmits.map((e) => e.channel)).not.toContain('job:complete');
  });

  it('does not re-send a batch it has verified durable', async () => {
    // Pins the probe against ONE tempting wrong shape: "re-commit and see" —
    // idempotency at the log makes a second commit harmless to the data,
    // so it looks like a free way to answer the question. It is not. It doubles
    // the work, and when the ack was lost because the gateway is DOWN, the
    // re-commit just times out again and answers nothing. Ask the log what it
    // holds; do not write to it to find out.
    const h = makeFakeWorker();
    h.commitSink.mode = 'ack-lost';

    await runPastCommitTimeout(h);

    expect(h.busEmits.filter((e) => e.channel === 'mark:commit')).toHaveLength(1);
  });
});

describe('the record says HOW durability was established', () => {
  // Auditable provenance, not a status badge. There are four distinct
  // evidentiary states, and without the field they collapse into two records:
  // an acknowledged completion reads exactly like one inferred from a single
  // annotation's presence, and "the log says it isn't there" reads exactly like
  // "the log never answered". A record that cannot tell diligence from a gap
  // cannot be audited.
  //
  // The field carries the OBSERVATION, never a conclusion. `probe-refused` says
  // the read returned a failure reply — not that the annotations are absent,
  // which the worker does not know: a read that threw for its own reasons comes
  // back on the same channel.

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function run(h: ReturnType<typeof makeFakeWorker>) {
    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [{ id: 'a1' }, { id: 'a2' }] as never,
      result: { found: 2, persisted: 2 } as never,
    }));
    const settled = handleHeld(h, makeConfig(h.client), makeJob('highlighting'))
      .then(() => 'completed' as const, (e) => e as Error);
    await vi.advanceTimersByTimeAsync(61_000);
    return settled;
  }

  const terminal = (h: ReturnType<typeof makeFakeWorker>, channel: string) =>
    h.busEmits.find((e) => e.channel === channel)?.payload as Record<string, unknown> | undefined;

  it('an acknowledged commit completes as acknowledged', async () => {
    const h = makeFakeWorker();
    await run(h);
    expect(terminal(h, 'job:complete')).toMatchObject({ durability: 'acknowledged' });
  });

  it('a completion rescued by the probe says so — it is a weaker claim', async () => {
    // Inferred from ONE annotation's presence, resting on the Stower's
    // append-ordering invariant. True, and not the same evidence as an ack.
    const h = makeFakeWorker();
    h.commitSink.mode = 'ack-lost';
    await run(h);
    expect(terminal(h, 'job:complete')).toMatchObject({ durability: 'probe-confirmed' });
  });

  /**
   * `job:fail` is emitted by the OUTER catch in startWorkerProcess, not by
   * handleJob (which throws), so the failure-side record can only be observed
   * through the real entry point.
   */
  async function runToFailure(setup: (h: ReturnType<typeof makeFakeWorker>) => void) {

    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [{ id: 'a1' }, { id: 'a2' }] as never,
      result: { found: 2, persisted: 2 } as never,
    }));
    const h = makeFakeWorker();
    setup(h);
    startWorkerProcess(makeConfig(h.client));
    h.offer(makeJob('highlighting'));
    // Past the commit's 60 s bound on the fake clock; advanceTimersByTimeAsync
    // flushes the detached promise chain startWorkerProcess runs the job on.
    await vi.advanceTimersByTimeAsync(61_000);

    return h.busEmits.find((e) => e.channel === 'job:fail')?.payload as Record<string, unknown> | undefined;
  }

  it('a probe that was answered "no" is recorded as refused, not as absence', async () => {
    const payload = await runToFailure((h) => { h.commitSink.mode = 'silent'; });
    expect(payload).toMatchObject({ durability: 'probe-refused' });
  });

  it('a probe nobody answered is recorded as unreachable', async () => {
    // The gateway-down branch, and the one a plain record cannot distinguish
    // from the case above.
    const payload = await runToFailure((h) => {
      h.commitSink.mode = 'ack-lost';
      h.probeSink.mode = 'unreachable';
    });
    expect(payload).toMatchObject({ durability: 'probe-unreachable' });
  });

  it('the original failure message survives — the field adds evidence, it does not replace it', async () => {
    const payload = await runToFailure((h) => {
      h.commitSink.mode = 'ack-lost';
      h.probeSink.mode = 'unreachable';
    });
    expect(String(payload?.error)).toContain('mark:commit-ok');
  });

  it('a job whose LAST batch needed the probe does not claim the first batch\'s ack', async () => {
    // Generation commits twice — provenance on the source, citations on the
    // derived resource. If the fold kept the FIRST answer, a job could report
    // 'acknowledged' while part of its output rests on an inferred probe: an
    // overstatement, and precisely what this field exists to prevent. Weakest
    // evidence wins, because that is the strongest claim still true of the job.
    vi.mocked(processGenerationJob).mockResolvedValue({
      content: new TextEncoder().encode('Paris is the capital of France.'),
      title: 'Answer',
      format: 'text/markdown',
      citations: [{ resourceId: 'ctx-9', start: 0, end: 31, exact: 'Paris is the capital of France.' }],
      truncated: false,
    } as never);
    const h = makeFakeWorker();
    h.commitSink.mode = 'first-ok-then-lost';

    const settled = handleHeld(h, makeConfig(h.client), makeJob('yield', { cite: true }))
      .then(() => 'completed' as const, (e) => e as Error);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await settled).toBe('completed');

    expect(h.busEmits.filter((e) => e.channel === 'mark:commit')).toHaveLength(2);
    expect(terminal(h, 'job:complete')).toMatchObject({ durability: 'probe-confirmed' });
  });

  it('a job that committed nothing states nothing — absent is not a value', async () => {
    // No batch, so no durability question arose. Writing 'acknowledged' here
    // would be a manufactured claim.
    vi.mocked(processHighlightJob).mockImplementation(emitting({
      annotations: [] as never,
      result: { found: 0, persisted: 0 } as never,
    }));
    const h = makeFakeWorker();
    await handleHeld(h, makeConfig(h.client), makeJob('highlighting'));
    expect(terminal(h, 'job:complete')).not.toHaveProperty('durability');
  });
});

// When an attempt fails and the queue re-runs the whole job, the
// operator-visible signal would otherwise be NONE: heartbeats continue, and
// nothing anywhere says "this document is running for the second time".
// Provider spend is in Prometheus; the attempt number is the key that ties it
// to a re-run.
describe('every event says which attempt produced it', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const retried = (n: number) => makeJob('highlighting', {}, [], { retryCount: n, maxRetries: 1 });

  it('progress and the terminal event both carry the attempt number', async () => {
    vi.mocked(processHighlightJob).mockImplementation((async (...args: unknown[]) => {
      const onProgress = args[4] as (p: number, m: unknown) => void;
      const onChunkComplete = args[5] as (a: unknown[], c: UnitCheckpoint) => Promise<void>;
      onProgress(60, { code: 'creating-annotations', count: 1 });
      await onChunkComplete([{ id: 'a1' }], { unit: 'highlighting', cursor: { next: 900, size: 220, found: 0, emitted: 0, errors: 0 } });
      return { result: { found: 1, persisted: 1 } } as never;
    }) as never);
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), retried(1));   // retryCount 1 ⇒ attempt 2

    const progress = h.busEmits.filter((e) => e.channel === 'job:report-progress');
    expect(progress.length).toBeGreaterThan(0);
    for (const e of progress) {
      expect((e.payload as Record<string, unknown>).attempt).toBe(2);
    }
    expect(h.busEmits.find((e) => e.channel === 'job:complete')!.payload).toMatchObject({ attempt: 2 });
  });

  it('a first attempt says 1 — the fact is always stated, never inferred from absence', async () => {
    vi.mocked(processHighlightJob).mockImplementation(emitting({ annotations: [], result: { found: 0, persisted: 0 } }));
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), retried(0));

    expect(h.busEmits.find((e) => e.channel === 'job:complete')!.payload).toMatchObject({ attempt: 1 });
  });
});

/**
 * A job is labelled as its description names it: `job.type` is the verb, and a
 * `mark` job says its motivation in `job.motivation`, a label a `yield` job
 * does not have (specs/src/service-telemetry/telemetry.json, the worker's rows).
 */
describe('what a job is labelled with', () => {
  const jobSpan = () => vi.mocked(withSpan).mock.calls.find(([name]) => name.startsWith('job:'));

  it('a mark job: its type, and its motivation in a label of its own', async () => {
    vi.mocked(processTagJob).mockImplementation(emitting({ annotations: [], result: { found: 0, persisted: 0 } }));
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), makeJob('tagging'));

    expect(recordJobOutcome).toHaveBeenCalledWith({ jobType: 'mark', motivation: 'tagging' }, 'completed', expect.any(Number));
    const [name, , options] = jobSpan()!;
    expect(name).toBe('job:mark');
    expect(options?.attrs).toMatchObject({ 'job.type': 'mark', 'job.motivation': 'tagging', 'job.id': JID, 'resource.id': RID });
  });

  it('a yield job: its type, and no motivation', async () => {
    vi.mocked(processGenerationJob).mockResolvedValue({
      content: new TextEncoder().encode('# Generated'), title: 'New Resource', format: 'text/markdown', citations: [], truncated: false,
    });
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), makeJob('yield', { context: minimalContext('annotation') }));

    expect(recordJobOutcome).toHaveBeenCalledWith({ jobType: 'yield' }, 'completed', expect.any(Number));
    const [name, , options] = jobSpan()!;
    expect(name).toBe('job:yield');
    expect(options?.attrs).not.toHaveProperty('job.motivation');
  });

  it('a job that fails is counted as failed, under the same labels', async () => {
    vi.mocked(processHighlightJob).mockRejectedValue(new Error('inference blew up'));
    const h = makeFakeWorker();

    await handleHeld(h, makeConfig(h.client), makeJob('highlighting')).catch(() => {});

    expect(recordJobOutcome).toHaveBeenCalledWith({ jobType: 'mark', motivation: 'highlighting' }, 'failed', expect.any(Number));
  });
});

