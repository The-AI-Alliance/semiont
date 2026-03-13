/**
 * Assessment Detection Worker Event Emission Tests
 *
 * Tests that AssessmentAnnotationWorker emits proper events on EventBus
 * during assessment detection processing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { AssessmentAnnotationWorker } from '../../../workers/assessment-annotation-worker';
import { JobQueue, type RunningJob, type AssessmentDetectionParams, type AssessmentDetectionProgress, type ContentFetcher } from '@semiont/jobs';
import { resourceId, userId, EventBus, type Logger } from '@semiont/core';
import { jobId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

describe('AssessmentAnnotationWorker - Event Emission', () => {
  let worker: AssessmentAnnotationWorker;
  let testDir: string;
  let eventBus: EventBus;

  beforeAll(async () => {
    // Initialize mock client
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['[]']);

    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-assessment-worker-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    const jobQueue = new JobQueue({ dataDir: testDir }, mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new AssessmentAnnotationWorker(jobQueue, mockInferenceClient, eventBus, mockContentFetcher, mockLogger);
    mockInferenceClient.setResponses(['[]']);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeJob(id: string, resId: string): RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress> {
    return {
      status: 'running',
      metadata: {
        id: jobId(id),
        type: 'assessment-annotation',
        userId: userId('user-1'),
        userName: 'Test User',
        userEmail: 'test@test.local',
        userDomain: 'test.local',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(resId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };
  }

  it('should emit job:start event when assessment detection begins', async () => {
    const testResourceId = `resource-assessment-started-${Date.now()}`;
    mockInferenceClient.setResponses([JSON.stringify([])]);

    const startEvents: any[] = [];
    const sub = eventBus.get('job:start').subscribe(e => startEvents.push(e));

    const job = makeJob('job-assessment-1', testResourceId);
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(startEvents.length).toBeGreaterThanOrEqual(1);
    expect(startEvents[0]).toMatchObject({
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      jobId: jobId('job-assessment-1'),
      jobType: 'assessment-annotation'
    });
  });

  it('should emit job:report-progress events during assessment detection', async () => {
    const testResourceId = `resource-assessment-progress-${Date.now()}`;
    mockInferenceClient.setResponses([JSON.stringify([
      {
        exact: 'test content',
        start: 0,
        end: 12,
        assessment: 'This claim lacks supporting evidence',
        prefix: '',
        suffix: ''
      }
    ])]);

    const progressEvents: any[] = [];
    const sub = eventBus.get('job:report-progress').subscribe(e => progressEvents.push(e));

    const job = makeJob('job-assessment-2', testResourceId);
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0]).toMatchObject({
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      jobId: jobId('job-assessment-2'),
    });
  });

  it('should emit job:complete event when assessment detection finishes', async () => {
    const testResourceId = `resource-assessment-complete-${Date.now()}`;
    mockInferenceClient.setResponses([JSON.stringify([
      {
        exact: 'test content',
        start: 0,
        end: 12,
        assessment: 'Needs verification',
        prefix: '',
        suffix: ''
      }
    ])]);

    const completeEvents: any[] = [];
    const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

    const job = makeJob('job-assessment-3', testResourceId);
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    sub.unsubscribe();

    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents[0]).toMatchObject({
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      jobId: jobId('job-assessment-3'),
      jobType: 'assessment-annotation',
    });
  });

  it('should emit mark:create events for detected assessments', async () => {
    const testResourceId = `resource-assessment-annotations-${Date.now()}`;
    mockInferenceClient.setResponses([JSON.stringify([
      {
        exact: 'test',
        start: 0,
        end: 4,
        assessment: 'This claim lacks empirical support',
        prefix: '',
        suffix: ' content'
      },
      {
        exact: 'content',
        start: 5,
        end: 12,
        assessment: 'Requires additional verification',
        prefix: 'test ',
        suffix: ''
      }
    ])]);

    const markEvents: any[] = [];
    const sub = eventBus.get('mark:create').subscribe(e => markEvents.push(e));

    const job = makeJob('job-assessment-4', testResourceId);
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(markEvents.length).toBe(2);

    // Check first assessment annotation
    expect(markEvents[0]).toMatchObject({
      annotation: expect.objectContaining({ motivation: 'assessing' }),
      userId: userId('user-1'),
      resourceId: resourceId(testResourceId),
    });
    expect(markEvents[0].annotation.body).toMatchObject({
      value: 'This claim lacks empirical support'
    });

    // Check second assessment annotation
    expect(markEvents[1]).toMatchObject({
      annotation: expect.objectContaining({ motivation: 'assessing' }),
      userId: userId('user-1'),
      resourceId: resourceId(testResourceId),
    });
    expect(markEvents[1].annotation.body).toMatchObject({
      value: 'Requires additional verification'
    });
  });
});
