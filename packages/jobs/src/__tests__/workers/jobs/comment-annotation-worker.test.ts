/**
 * Comment Detection Worker Event Emission Tests
 *
 * Tests that CommentAnnotationWorker emits proper events on EventBus
 * during comment detection processing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { CommentAnnotationWorker } from '../../../workers/comment-annotation-worker';
import { JobQueue, type RunningJob, type CommentDetectionParams, type CommentDetectionProgress, type ContentFetcher } from '@semiont/jobs';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, userId, EventBus, jobId, type Logger } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Mock @semiont/inference to avoid external API calls
let mockInferenceClient: any;

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  return {
    getInferenceClient: vi.fn().mockResolvedValue(new MockInferenceClient(['[]'])),
    MockInferenceClient
  };
});

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

const mockContentFetcher: ContentFetcher = async () => {
  const { Readable } = await import('stream');
  return Readable.from([Buffer.from('test content')]);
};

describe('CommentAnnotationWorker - Event Emission', () => {
  let worker: CommentAnnotationWorker;
  let testDir: string;
  let eventBus: EventBus;

  beforeAll(async () => {
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['[]']);

    testDir = join(tmpdir(), `semiont-test-comment-worker-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    const jobQueue = new JobQueue(new SemiontProject(testDir), mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new CommentAnnotationWorker(jobQueue, mockInferenceClient, eventBus, mockContentFetcher, mockLogger);
    mockInferenceClient.setResponses(['[]']);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeJob(id: string, resId: string): RunningJob<CommentDetectionParams, CommentDetectionProgress> {
    return {
      status: 'running',
      metadata: {
        id: jobId(id),
        type: 'comment-annotation',
        userId: userId('user-1'),
        userName: 'Test User',
        userEmail: 'test@test.local',
        userDomain: 'test.local',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: { resourceId: resourceId(resId) },
      startedAt: new Date().toISOString(),
      progress: { stage: 'analyzing', percentage: 0, message: 'Initializing' }
    };
  }

  it('should emit job:start event when comment detection begins', async () => {
    mockInferenceClient.setResponses([JSON.stringify([])]);

    const startEvents: any[] = [];
    const sub = eventBus.get('job:start').subscribe(e => startEvents.push(e));

    const job = makeJob('job-comment-1', 'res-comment-1');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(startEvents.length).toBeGreaterThanOrEqual(1);
    expect(startEvents[0]).toMatchObject({
      resourceId: resourceId('res-comment-1'),
      userId: userId('user-1'),
      jobId: jobId('job-comment-1'),
      jobType: 'comment-annotation'
    });
  });

  it('should emit job:report-progress events during comment detection', async () => {
    mockInferenceClient.setResponses([JSON.stringify([
      { exact: 'test content', start: 0, end: 12, comment: 'This is a test comment', prefix: '', suffix: '' }
    ])]);

    const progressEvents: any[] = [];
    const sub = eventBus.get('job:report-progress').subscribe(e => progressEvents.push(e));

    const job = makeJob('job-comment-2', 'res-comment-2');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0]).toMatchObject({
      resourceId: resourceId('res-comment-2'),
      userId: userId('user-1'),
      jobId: jobId('job-comment-2'),
    });
  });

  it('should emit job:complete event when comment detection finishes', async () => {
    mockInferenceClient.setResponses([JSON.stringify([
      { exact: 'test', start: 0, end: 4, comment: 'A comment', prefix: '', suffix: ' content' }
    ])]);

    const completeEvents: any[] = [];
    const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

    const job = makeJob('job-comment-3', 'res-comment-3');
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    sub.unsubscribe();

    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents[0]).toMatchObject({
      resourceId: resourceId('res-comment-3'),
      userId: userId('user-1'),
      jobId: jobId('job-comment-3'),
      jobType: 'comment-annotation',
    });
  });

  it('should emit mark:create events for detected comments', async () => {
    mockInferenceClient.setResponses([JSON.stringify([
      { exact: 'test', start: 0, end: 4, comment: 'First comment', prefix: '', suffix: ' content' },
      { exact: 'content', start: 5, end: 12, comment: 'Second comment', prefix: 'test ', suffix: '' }
    ])]);

    const markEvents: any[] = [];
    const sub = eventBus.get('mark:create').subscribe(e => markEvents.push(e));

    const job = makeJob('job-comment-4', 'res-comment-4');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(markEvents.length).toBe(2);

    expect(markEvents[0]).toMatchObject({
      annotation: expect.objectContaining({ motivation: 'commenting' }),
      userId: userId('user-1'),
      resourceId: resourceId('res-comment-4'),
    });
    expect(markEvents[0].annotation.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'First comment' })])
    );

    expect(markEvents[1]).toMatchObject({
      annotation: expect.objectContaining({ motivation: 'commenting' }),
      userId: userId('user-1'),
      resourceId: resourceId('res-comment-4'),
    });
    expect(markEvents[1].annotation.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'Second comment' })])
    );
  });
});
