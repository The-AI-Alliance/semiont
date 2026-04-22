/**
 * Unit tests for worker-process orchestration.
 *
 * The `handleJob` function in worker-process.ts owns the end-to-end
 * contract from a claimed job through to completion. Under the unified
 * job:* lifecycle, every invocation emits:
 *
 *   job:start                                  (at entry)
 *     → for each returned annotation: mark:create
 *     → yield:create (generation only; creates the resource)
 *     → job:complete                            (at success exit)
 *
 * On failure the outer wrapper (startWorkerProcess) emits `job:fail`
 * and calls vm.failJob(); we exercise that by letting a processor
 * throw and checking the caller handles it.
 *
 * Processors' return values are covered by processors.test.ts. This
 * file covers the iterate-and-emit orchestration layer, which is
 * otherwise only reached by e2e tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerVM, ActiveJob } from '@semiont/api-client';
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

// Mock global fetch — worker-process fetches resource content via HTTP.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const RID = 'res-abc';
const UID = 'did:web:example.com:users:test';
const JID = 'job-xyz';

/** Capture every emitEvent + state-change call on the VM in order. */
interface VMCall { method: string; args: unknown[]; }

function makeFakeVM(): { vm: WorkerVM; calls: VMCall[] } {
  const calls: VMCall[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return method === 'emitEvent' ? Promise.resolve() : undefined;
  };
  const vm = {
    activeJob$:     { subscribe: vi.fn() },
    isProcessing$:  { subscribe: vi.fn() },
    jobsCompleted$: { subscribe: vi.fn() },
    errors$:        { subscribe: vi.fn() },
    start:       record('start'),
    stop:        record('stop'),
    emitEvent:   record('emitEvent'),
    completeJob: record('completeJob'),
    failJob:     record('failJob'),
    dispose:     record('dispose'),
  } as unknown as WorkerVM;
  return { vm, calls };
}

function makeConfig(): WorkerProcessConfig {
  return {
    baseUrl: 'http://fake:4000',
    token: 'tok',
    jobTypes: [],
    inferenceClient: {} as never,
    generator: { type: 'Software', id: 's', name: 's', homepage: 'https://x' } as never,
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

/** Extract emitEvent payloads grouped by channel, preserving insertion order. */
function emitSequence(calls: VMCall[]): Array<{ channel: string; payload: unknown }> {
  return calls
    .filter(c => c.method === 'emitEvent')
    .map(c => ({ channel: c.args[0] as string, payload: c.args[1] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'the content' });
});

describe('handleJob orchestration', () => {

  // ── Annotation jobs — all five follow the same shape. Each suite asserts:
  //   (1) processor was called
  //   (2) leads with `job:start` carrying jobId + jobType
  //   (3) exactly N `mark:create` emits (N = returned annotation count), in order
  //   (4) exactly one `job:complete` emit carrying jobType + result
  //   (5) completeJob called exactly once, AFTER the above

  describe('highlight-annotation', () => {
    it('emits job:start, mark:create per annotation, then job:complete', async () => {
      vi.mocked(processHighlightJob).mockResolvedValue({
        annotations: [{ id: 'a1' }, { id: 'a2' }] as never,
        result: { highlightsFound: 2, highlightsCreated: 2 } as never,
      });
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('highlight-annotation'));

      const emits = emitSequence(calls);
      expect(emits.map(e => e.channel)).toEqual([
        'job:start', 'mark:create', 'mark:create', 'job:complete',
      ]);
      expect(emits[0]!.payload).toMatchObject({ jobId: JID, jobType: 'highlight-annotation', resourceId: RID });
      expect(emits[1]!.payload).toEqual({ annotation: { id: 'a1' }, userId: UID, resourceId: RID });
      expect(emits[2]!.payload).toEqual({ annotation: { id: 'a2' }, userId: UID, resourceId: RID });
      expect(emits[3]!.payload).toMatchObject({
        jobId: JID, jobType: 'highlight-annotation', resourceId: RID,
        result: { highlightsFound: 2, highlightsCreated: 2 },
      });
      const order = calls.map(c => c.method);
      expect(order[order.length - 1]).toBe('completeJob');
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(1);
      expect(calls.filter(c => c.method === 'failJob')).toHaveLength(0);
    });
  });

  describe('comment-annotation', () => {
    it('emits job:start, mark:create × N, job:complete with commenting result', async () => {
      vi.mocked(processCommentJob).mockResolvedValue({
        annotations: [{ id: 'c1' }] as never,
        result: { commentsFound: 1, commentsCreated: 1 } as never,
      });
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('comment-annotation'));

      const emits = emitSequence(calls);
      expect(emits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'job:complete']);
      expect(emits[2]!.payload).toMatchObject({
        jobType: 'comment-annotation',
        result: { commentsFound: 1, commentsCreated: 1 },
      });
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('assessment-annotation', () => {
    it('emits job:start, mark:create × N, job:complete with assessing result', async () => {
      vi.mocked(processAssessmentJob).mockResolvedValue({
        annotations: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] as never,
        result: { assessmentsFound: 3, assessmentsCreated: 3 } as never,
      });
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('assessment-annotation'));

      const emits = emitSequence(calls);
      expect(emits.map(e => e.channel)).toEqual([
        'job:start', 'mark:create', 'mark:create', 'mark:create', 'job:complete',
      ]);
      expect(emits[4]!.payload).toMatchObject({
        jobType: 'assessment-annotation',
        result: { assessmentsFound: 3, assessmentsCreated: 3 },
      });
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('reference-annotation', () => {
    it('emits job:start, mark:create × N, job:complete with linking result', async () => {
      vi.mocked(processReferenceJob).mockResolvedValue({
        annotations: [{ id: 'r1' }, { id: 'r2' }] as never,
        result: { totalFound: 2, totalEmitted: 2, errors: 0 } as never,
      });
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('reference-annotation'));

      const emits = emitSequence(calls);
      expect(emits.map(e => e.channel)).toEqual([
        'job:start', 'mark:create', 'mark:create', 'job:complete',
      ]);
      expect(emits[3]!.payload).toMatchObject({
        jobType: 'reference-annotation',
        result: { totalFound: 2, totalEmitted: 2, errors: 0 },
      });
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });

    it('emits job:start then job:complete (zero mark:create) when processor returns no annotations', async () => {
      vi.mocked(processReferenceJob).mockResolvedValue({
        annotations: [] as never,
        result: { totalFound: 0, totalEmitted: 0, errors: 0 } as never,
      });
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('reference-annotation'));

      const emits = emitSequence(calls);
      expect(emits.map(e => e.channel)).toEqual(['job:start', 'job:complete']);
      expect(emits[1]!.payload).toMatchObject({
        result: { totalFound: 0, totalEmitted: 0, errors: 0 },
      });
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('tag-annotation', () => {
    it('emits job:start, mark:create × N, job:complete with tagging result', async () => {
      vi.mocked(processTagJob).mockResolvedValue({
        annotations: [{ id: 't1' }] as never,
        result: { tagsFound: 1, tagsCreated: 1, byCategory: {} } as never,
      });
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('tag-annotation'));

      const emits = emitSequence(calls);
      expect(emits.map(e => e.channel)).toEqual(['job:start', 'mark:create', 'job:complete']);
      expect(emits[2]!.payload).toMatchObject({
        jobType: 'tag-annotation',
        result: { tagsFound: 1, tagsCreated: 1 },
      });
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('generation', () => {
    it('emits job:start, yield:create, job:complete with resourceName', async () => {
      vi.mocked(processGenerationJob).mockResolvedValue({
        content: '# Generated\n\nBody.',
        title: 'New Resource',
        format: 'text/markdown',
        result: { tokensUsed: 100 } as never,
      });
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('generation', { referenceId: 'ref-1' }));

      const emits = emitSequence(calls);
      expect(emits.map(e => e.channel)).toEqual(['job:start', 'yield:create', 'job:complete']);
      expect(emits[1]!.payload).toMatchObject({
        name: 'New Resource',
        content: '# Generated\n\nBody.',
        format: 'text/markdown',
        resourceId: RID,
        referenceId: 'ref-1',
      });
      expect(emits[2]!.payload).toMatchObject({
        jobType: 'generation',
        result: { resourceName: 'New Resource' },
      });
      // No mark:create on generation
      expect(emits.map(e => e.channel)).not.toContain('mark:create');
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(1);
    });
  });

  describe('unknown job type', () => {
    it('calls vm.failJob with a descriptive message after emitting job:start', async () => {
      const { vm, calls } = makeFakeVM();

      await handleJob(vm, makeConfig(), makeJob('weird-thing' as never));

      // job:start fires before the dispatch branch; unknown path calls failJob.
      expect(emitSequence(calls).map(e => e.channel)).toEqual(['job:start']);
      const fail = calls.find(c => c.method === 'failJob');
      expect(fail).toBeDefined();
      expect(fail!.args[0]).toBe(JID);
      expect(String(fail!.args[1])).toMatch(/Unknown job type: weird-thing/);
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(0);
    });
  });

  describe('processor throws', () => {
    it('propagates the error (caller wraps with job:fail + vm.failJob)', async () => {
      vi.mocked(processReferenceJob).mockRejectedValue(new Error('inference blew up'));
      const { vm, calls } = makeFakeVM();

      await expect(
        handleJob(vm, makeConfig(), makeJob('reference-annotation'))
      ).rejects.toThrow('inference blew up');

      // On failure, handleJob itself does NOT emit job:complete.
      // job:start still fires at entry; the outer wrapper emits job:fail.
      expect(emitSequence(calls).some(e => e.channel === 'job:complete')).toBe(false);
      expect(calls.filter(c => c.method === 'completeJob')).toHaveLength(0);
    });
  });
});
