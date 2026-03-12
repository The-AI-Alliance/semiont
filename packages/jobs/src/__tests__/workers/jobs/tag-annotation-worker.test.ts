/**
 * Tag Annotation Worker Event Emission Tests
 *
 * Tests that TagAnnotationWorker emits proper events on EventBus
 * during structural tag detection processing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { TagAnnotationWorker } from '../../../workers/tag-annotation-worker';
import { JobQueue, type RunningJob, type TagDetectionParams, type TagDetectionProgress, type ContentFetcher } from '@semiont/jobs';
import { resourceId, userId, type EnvironmentConfig, EventBus, type Logger } from '@semiont/core';
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

// Mock @semiont/ontology to provide tag schema
vi.mock('@semiont/ontology', () => ({
  getTagSchema: vi.fn().mockReturnValue({
    id: 'imrad',
    name: 'IMRAD',
    description: 'Introduction, Methods, Results, and Discussion structure',
    domain: 'academic',
    tags: [
      { name: 'Introduction' },
      { name: 'Methods' },
      { name: 'Results' },
      { name: 'Discussion' }
    ]
  }),
  getSchemaCategory: vi.fn((_schemaId: string, categoryName: string) => ({
    name: categoryName,
    description: `${categoryName} section`,
    examples: [`What is ${categoryName.toLowerCase()}?`, `How does ${categoryName.toLowerCase()} work?`]
  }))
}));

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

describe('TagAnnotationWorker - Event Emission', () => {
  let worker: TagAnnotationWorker;
  let testDir: string;
  let config: EnvironmentConfig;
  let eventBus: EventBus;

  beforeAll(async () => {
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['[]']);

    testDir = join(tmpdir(), `semiont-test-tag-worker-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    config = {
      services: {
        filesystem: { platform: { type: 'posix' }, path: testDir },
        backend: { platform: { type: 'posix' }, port: 4000, publicURL: 'http://localhost:4000', corsOrigin: 'http://localhost:3000' },
        inference: { platform: { type: 'external' }, type: 'anthropic', model: 'claude-sonnet-4-20250514', maxTokens: 8192, endpoint: 'https://api.anthropic.com', apiKey: 'test-api-key' },
        graph: { platform: { type: 'posix' }, type: 'memory' }
      },
      site: { siteName: 'Test Site', domain: 'localhost:3000', adminEmail: 'admin@test.local', oauthAllowedDomains: ['test.local'] },
      _metadata: { environment: 'test', projectRoot: testDir },
    } as EnvironmentConfig;
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    const jobQueue = new JobQueue({ dataDir: testDir }, mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new TagAnnotationWorker(jobQueue, config, mockInferenceClient, eventBus, mockContentFetcher, mockLogger);
    mockInferenceClient.setResponses(['[]']);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeJob(id: string, resId: string, categories: string[] = ['Introduction', 'Methods', 'Results', 'Discussion']): RunningJob<TagDetectionParams, TagDetectionProgress> {
    return {
      status: 'running',
      metadata: {
        id: jobId(id),
        type: 'tag-annotation',
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
        schemaId: 'imrad',
        categories,
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        totalCategories: categories.length,
        processedCategories: 0,
        message: 'Initializing'
      }
    };
  }

  it('should emit job:start event when tag detection begins', async () => {
    mockInferenceClient.setResponses([
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([])
    ]);

    const startEvents: any[] = [];
    const sub = eventBus.get('job:start').subscribe(e => startEvents.push(e));

    const job = makeJob('job-tag-1', 'res-tag-1');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(startEvents.length).toBeGreaterThanOrEqual(1);
    expect(startEvents[0]).toMatchObject({
      resourceId: resourceId('res-tag-1'),
      userId: userId('user-1'),
      jobId: jobId('job-tag-1'),
      jobType: 'tag-annotation'
    });
  });

  it('should emit job:report-progress events during category scanning', async () => {
    mockInferenceClient.setResponses([
      JSON.stringify([{ exact: 'test content', start: 0, end: 12, prefix: '', suffix: '' }]),
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([])
    ]);

    const progressEvents: any[] = [];
    const sub = eventBus.get('job:report-progress').subscribe(e => progressEvents.push(e));

    const job = makeJob('job-tag-2', 'res-tag-2');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0]).toMatchObject({
      resourceId: resourceId('res-tag-2'),
      userId: userId('user-1'),
      jobId: jobId('job-tag-2'),
    });
  });

  it('should emit job:complete event when tag detection finishes', async () => {
    mockInferenceClient.setResponses([
      JSON.stringify([{ exact: 'test content', start: 0, end: 12, prefix: '', suffix: '' }]),
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([])
    ]);

    const completeEvents: any[] = [];
    const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

    const job = makeJob('job-tag-3', 'res-tag-3');
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    sub.unsubscribe();

    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents[0]).toMatchObject({
      resourceId: resourceId('res-tag-3'),
      userId: userId('user-1'),
      jobId: jobId('job-tag-3'),
      jobType: 'tag-annotation',
    });
  });

  it('should emit mark:create events for detected tags', async () => {
    // Mock AI responses - one for each category
    mockInferenceClient.setResponses([
      JSON.stringify([{ exact: 'test', start: 0, end: 4, prefix: '', suffix: ' content' }]),
      JSON.stringify([{ exact: 'content', start: 5, end: 12, prefix: 'test ', suffix: '' }]),
      JSON.stringify([]),
      JSON.stringify([]),
    ]);

    const markEvents: any[] = [];
    const sub = eventBus.get('mark:create').subscribe(e => markEvents.push(e));

    const job = makeJob('job-tag-4', 'res-tag-4');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(markEvents.length).toBe(2);

    // All annotations should be tagging motivation
    for (const event of markEvents) {
      expect(event).toMatchObject({
        annotation: expect.objectContaining({ motivation: 'tagging' }),
        userId: userId('user-1'),
        resourceId: resourceId('res-tag-4'),
      });
    }
  });
});
