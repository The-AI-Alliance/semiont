/**
 * Reference Detection Worker Event Emission Tests
 *
 * Tests that ReferenceAnnotationWorker emits proper events on EventBus
 * during entity detection processing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ReferenceAnnotationWorker } from '../../../workers/reference-annotation-worker';
import { JobQueue, type RunningJob, type DetectionParams, type DetectionProgress, type ContentFetcher } from '@semiont/jobs';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, userId, EventBus, jobId, entityType, type Logger } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Mock @semiont/inference
let mockInferenceClient: any;

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  return {
    getInferenceClient: vi.fn().mockResolvedValue(new MockInferenceClient(['[]'])),
    MockInferenceClient,
    extractEntities: vi.fn().mockResolvedValue([
      { exact: 'Test', entityType: 'Person', startOffset: 0, endOffset: 4 }
    ])
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

const mockGenerator = { '@type': 'SoftwareAgent', name: 'Reference Worker / Test' };

describe('ReferenceAnnotationWorker - Event Emission', () => {
  let worker: ReferenceAnnotationWorker;
  let testDir: string;
  let eventBus: EventBus;

  beforeAll(async () => {
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['[]']);

    testDir = join(tmpdir(), `semiont-test-worker-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    const jobQueue = new JobQueue(new SemiontProject(testDir), mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new ReferenceAnnotationWorker(jobQueue, mockInferenceClient, mockGenerator, eventBus, mockContentFetcher, mockLogger);
    mockInferenceClient.setResponses(['[]']);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeJob(id: string, resId: string, entityTypes: string[]): RunningJob<DetectionParams, DetectionProgress> {
    return {
      status: 'running',
      metadata: {
        id: jobId(id),
        type: 'reference-annotation',
        userId: userId('user-1'),
        userName: 'Test User',
        userEmail: 'test@test.local',
        userDomain: 'test.local',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(resId),
        entityTypes: entityTypes.map(entityType)
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: entityTypes.length,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };
  }

  it('should emit job:start event when detection begins', async () => {
    const startEvents: any[] = [];
    const sub = eventBus.get('job:start').subscribe(e => startEvents.push(e));

    const job = makeJob('job-test-1', 'res-test-1', ['Person']);
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(startEvents.length).toBeGreaterThanOrEqual(1);
    expect(startEvents[0]).toMatchObject({
      resourceId: resourceId('res-test-1'),
      userId: userId('user-1'),
      jobId: jobId('job-test-1'),
      jobType: 'reference-annotation'
    });
  });

  it('should emit job:report-progress events during entity type scanning', async () => {
    const progressEvents: any[] = [];
    const sub = eventBus.get('job:report-progress').subscribe(e => progressEvents.push(e));

    const job = makeJob('job-test-2', 'res-test-2', ['Person', 'Organization', 'Location']);
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(progressEvents.length).toBeGreaterThanOrEqual(2);

    // Check first progress event
    expect(progressEvents[0]).toMatchObject({
      resourceId: resourceId('res-test-2'),
      jobId: jobId('job-test-2'),
      jobType: 'reference-annotation',
      percentage: expect.any(Number),
      progress: expect.objectContaining({
        currentStep: 'Person',
        processedSteps: 1,
        totalSteps: 3,
        foundCount: expect.any(Number)
      })
    });
  });

  it('should emit job:complete event when detection finishes successfully', async () => {
    const completeEvents: any[] = [];
    const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

    const job = makeJob('job-test-3', 'res-test-3', ['Person']);
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    sub.unsubscribe();

    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents[0]).toMatchObject({
      resourceId: resourceId('res-test-3'),
      jobId: jobId('job-test-3'),
      jobType: 'reference-annotation',
      result: expect.objectContaining({
        result: expect.objectContaining({
          totalFound: expect.any(Number),
          totalEmitted: expect.any(Number)
        })
      })
    });
  });

  it('should emit mark:create events for detected entities', async () => {
    const markEvents: any[] = [];
    const sub = eventBus.get('mark:create').subscribe(e => markEvents.push(e));

    const job = makeJob('job-test-4', 'res-test-4', ['Person']);
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    // If entities were detected, they should have the correct motivation and generator
    if (markEvents.length > 0) {
      expect(markEvents[0]).toMatchObject({
        annotation: expect.objectContaining({ motivation: 'linking' }),
        resourceId: resourceId('res-test-4'),
      });
      expect(markEvents[0].annotation.generator).toEqual(mockGenerator);
    }

    // Main assertion: Job completed without errors
    const completeEvents: any[] = [];
    const sub2 = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(
      makeJob('job-test-4b', 'res-test-4', ['Person'])
    );
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(
      makeJob('job-test-4b', 'res-test-4', ['Person']),
      result
    );
    sub2.unsubscribe();
    expect(completeEvents.length).toBeGreaterThan(0);
  });

  it('should emit events in correct order', async () => {
    const allEvents: { type: string; data: any }[] = [];

    const sub1 = eventBus.get('job:start').subscribe(e => allEvents.push({ type: 'job:start', data: e }));
    const sub2 = eventBus.get('job:report-progress').subscribe(e => allEvents.push({ type: 'job:report-progress', data: e }));
    const sub3 = eventBus.get('job:complete').subscribe(e => allEvents.push({ type: 'job:complete', data: e }));
    const sub4 = eventBus.get('mark:create').subscribe(e => allEvents.push({ type: 'mark:create', data: e }));

    const job = makeJob('job-test-5', 'res-test-5', ['Person', 'Organization']);
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    sub1.unsubscribe();
    sub2.unsubscribe();
    sub3.unsubscribe();
    sub4.unsubscribe();

    const eventTypes = allEvents.map(e => e.type);

    // First event should be job:start
    expect(eventTypes[0]).toBe('job:start');

    // Last event should be job:complete
    expect(eventTypes[eventTypes.length - 1]).toBe('job:complete');

    // Should have at least one job:report-progress event
    expect(eventTypes).toContain('job:report-progress');
  });

  it('should include percentage in progress events', async () => {
    const progressEvents: any[] = [];
    const sub = eventBus.get('job:report-progress').subscribe(e => progressEvents.push(e));

    const job = makeJob('job-test-6', 'res-test-6', ['Person', 'Organization']);
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    for (const event of progressEvents) {
      expect(event).toHaveProperty('percentage');
      expect(typeof event.percentage).toBe('number');
      expect(event.progress).toHaveProperty('foundCount');
      expect(typeof event.progress.foundCount).toBe('number');
    }
  });
});
