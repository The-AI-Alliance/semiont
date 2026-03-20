/**
 * Generation Worker Event Emission Tests
 *
 * Tests that GenerationWorker emits proper events on EventBus
 * during resource generation processing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { GenerationWorker } from '../../../workers/generation-worker';
import { JobQueue, type RunningJob, type GenerationParams, type YieldProgress } from '@semiont/jobs';
import { resourceId, userId, annotationId, EventBus, SemiontProject, type Logger } from '@semiont/core';
import { jobId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference to avoid external API calls
let mockInferenceClient: any;

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  return {
    getInferenceClient: vi.fn().mockResolvedValue(new MockInferenceClient(['# Test\n\nContent'])),
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

describe('GenerationWorker - Event Emission', () => {
  let worker: GenerationWorker;
  let testDir: string;
  let eventBus: EventBus;

  // Shared test fixtures
  const testSourceResource = {
    '@context': 'https://www.w3.org/ns/anno.jsonld' as const,
    '@id': 'test-resource-1',
    name: 'Test Resource',
    representations: [] as [],
    archived: false,
    creationMethod: 'ui' as const,
    dateCreated: '2026-01-01T00:00:00Z',
  };

  const testAnnotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    type: 'Annotation' as const,
    id: 'test-anno-1',
    motivation: 'linking' as const,
    target: {
      source: 'test-resource-1',
      selector: [
        { type: 'TextPositionSelector' as const, start: 0, end: 10 },
        { type: 'TextQuoteSelector' as const, exact: 'test text' }
      ]
    },
    body: [{ type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const }]
  };

  beforeAll(async () => {
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['# Test Title\n\nTest content']);

    testDir = join(tmpdir(), `semiont-test-generation-worker-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    const jobQueue = new JobQueue(new SemiontProject(testDir), mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new GenerationWorker(jobQueue, mockInferenceClient, eventBus, mockLogger);
    mockInferenceClient.setResponses(['# Test Title\n\nTest content']);

    // Simulate yield handler: when worker emits yield:create, respond with yield:created
    // Must be async so the response arrives after firstValueFrom subscribes to the race
    eventBus.get('yield:create').subscribe(() => {
      setTimeout(() => {
        eventBus.get('yield:created').next({
          resourceId: resourceId(`generated-${Date.now()}`),
          resource: {} as any, // Worker only reads resourceId
        } as any);
      }, 0);
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeJob(id: string, sourceResId: string, refId: string): RunningJob<GenerationParams, YieldProgress> {
    return {
      status: 'running',
      metadata: {
        id: jobId(id),
        type: 'generation',
        userId: userId('user-1'),
        userName: 'Test User',
        userEmail: 'test@test.local',
        userDomain: 'test.local',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId(refId),
        sourceResourceId: resourceId(sourceResId),
        sourceResourceName: 'Test Resource',
        annotation: testAnnotation,
        context: {
          annotation: testAnnotation,
          sourceResource: testSourceResource,
          sourceContext: {
            before: 'Context before ',
            selected: 'Test Topic',
            after: ' context after'
          }
        }
      },
      startedAt: new Date().toISOString(),
      progress: { stage: 'fetching', percentage: 0, message: 'Starting generation' }
    };
  }

  it('should emit job:start event when generation begins', async () => {
    mockInferenceClient.setResponses(['Generated content about Test Topic']);

    const startEvents: any[] = [];
    const sub = eventBus.get('job:start').subscribe(e => startEvents.push(e));

    const job = makeJob('job-gen-1', 'res-gen-1', 'ref-gen-1');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(startEvents.length).toBeGreaterThanOrEqual(1);
    expect(startEvents[0]).toMatchObject({
      resourceId: resourceId('res-gen-1'),
      userId: userId('user-1'),
      jobId: jobId('job-gen-1'),
      jobType: 'generation'
    });
  });

  it('should emit job:report-progress events through generation stages', async () => {
    mockInferenceClient.setResponses(['Generated content for progress tracking']);

    const progressEvents: any[] = [];
    const sub = eventBus.get('job:report-progress').subscribe(e => progressEvents.push(e));

    const job = makeJob('job-gen-2', 'res-gen-2', 'ref-gen-2');
    await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    // Should have multiple progress events for the various stages
    expect(progressEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('should emit job:complete event when generation finishes', async () => {
    mockInferenceClient.setResponses(['Generated content for completion test']);

    const completeEvents: any[] = [];
    const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

    const job = makeJob('job-gen-3', 'res-gen-3', 'ref-gen-3');
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: any, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    sub.unsubscribe();

    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents[0]).toMatchObject({
      resourceId: resourceId('res-gen-3'),
      userId: userId('user-1'),
      jobId: jobId('job-gen-3'),
      jobType: 'generation',
    });
  });

  it('should emit yield:create event for resource creation', async () => {
    mockInferenceClient.setResponses(['This is the content of a newly generated resource']);

    const yieldEvents: any[] = [];
    // Subscribe BEFORE the yield handler so we capture the event
    const sub = eventBus.get('yield:create').subscribe(e => yieldEvents.push(e));

    const job = makeJob('job-gen-4', 'res-gen-4', 'ref-gen-4');
    const result = await (worker as unknown as { executeJob: (job: any) => Promise<any> }).executeJob(job);

    sub.unsubscribe();

    expect(yieldEvents.length).toBeGreaterThanOrEqual(1);
    expect(yieldEvents[0]).toMatchObject({
      userId: userId('user-1'),
      format: 'text/markdown',
      isDraft: true,
    });

    // Verify the result contains a resourceId
    expect(result).toBeDefined();
    expect(result.resourceId).toBeDefined();
    expect(result.resourceName).toBeDefined();
  });
});
