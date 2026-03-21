/**
 * Highlight Detection Worker Event Emission Tests
 *
 * Tests that HighlightAnnotationWorker emits proper events on EventBus
 * during highlight detection processing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { HighlightAnnotationWorker } from '../../../workers/highlight-annotation-worker';
import { JobQueue, type RunningJob, type HighlightDetectionParams, type HighlightDetectionProgress, type ContentFetcher } from '@semiont/jobs';
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

describe('HighlightAnnotationWorker - Event Emission', () => {
  let worker: HighlightAnnotationWorker;
  let testDir: string;
  let eventBus: EventBus;

  beforeAll(async () => {
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['[]']);

    testDir = join(tmpdir(), `semiont-test-highlight-worker-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    const jobQueue = new JobQueue(new SemiontProject(testDir), mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new HighlightAnnotationWorker(jobQueue, mockInferenceClient, eventBus, mockContentFetcher, mockLogger);
    mockInferenceClient.setResponses(['[]']);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeJob(id: string, resId: string): RunningJob<HighlightDetectionParams, HighlightDetectionProgress> {
    return {
      status: 'running',
      metadata: {
        id: jobId(id),
        type: 'highlight-annotation',
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

  it('should emit job:start event when highlight detection begins', async () => {
    mockInferenceClient.setResponses([JSON.stringify([])]);

    const startEvents: any[] = [];
    const sub = eventBus.get('job:start').subscribe(e => startEvents.push(e));

    const job = makeJob('job-highlight-1', 'res-highlight-1');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(startEvents.length).toBeGreaterThanOrEqual(1);
    expect(startEvents[0]).toMatchObject({
      resourceId: resourceId('res-highlight-1'),
      userId: userId('user-1'),
      jobId: jobId('job-highlight-1'),
      jobType: 'highlight-annotation'
    });
  });

  it('should emit job:report-progress events during highlight detection', async () => {
    mockInferenceClient.setResponses([JSON.stringify([
      { exact: 'test content', start: 0, end: 12, prefix: '', suffix: '' }
    ])]);

    const progressEvents: any[] = [];
    const sub = eventBus.get('job:report-progress').subscribe(e => progressEvents.push(e));

    const job = makeJob('job-highlight-2', 'res-highlight-2');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0]).toMatchObject({
      resourceId: resourceId('res-highlight-2'),
      userId: userId('user-1'),
      jobId: jobId('job-highlight-2'),
    });
  });

  it('should emit job:complete event when highlight detection finishes', async () => {
    mockInferenceClient.setResponses([JSON.stringify([
      { exact: 'test', start: 0, end: 4, prefix: '', suffix: ' content' }
    ])]);

    const completeEvents: any[] = [];
    const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

    const job = makeJob('job-highlight-3', 'res-highlight-3');
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    sub.unsubscribe();

    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents[0]).toMatchObject({
      resourceId: resourceId('res-highlight-3'),
      userId: userId('user-1'),
      jobId: jobId('job-highlight-3'),
      jobType: 'highlight-annotation',
    });
  });

  it('should emit mark:create events for detected highlights', async () => {
    mockInferenceClient.setResponses([JSON.stringify([
      { exact: 'test', start: 0, end: 4, prefix: '', suffix: ' content' },
      { exact: 'content', start: 5, end: 12, prefix: 'test ', suffix: '' }
    ])]);

    const markEvents: any[] = [];
    const sub = eventBus.get('mark:create').subscribe(e => markEvents.push(e));

    const job = makeJob('job-highlight-4', 'res-highlight-4');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(markEvents.length).toBe(2);

    // Both annotations should be highlighting motivation
    expect(markEvents[0]).toMatchObject({
      annotation: expect.objectContaining({ motivation: 'highlighting' }),
      userId: userId('user-1'),
      resourceId: resourceId('res-highlight-4'),
    });

    expect(markEvents[1]).toMatchObject({
      annotation: expect.objectContaining({ motivation: 'highlighting' }),
      userId: userId('user-1'),
      resourceId: resourceId('res-highlight-4'),
    });
  });
});
