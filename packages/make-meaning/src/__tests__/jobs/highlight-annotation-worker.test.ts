/**
 * Highlight Detection Worker Event Emission Tests
 *
 * Tests that HighlightDetectionWorker emits proper job progress events to Event Store
 * during highlight detection processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HighlightDetectionWorker } from '../../jobs/highlight-annotation-worker';
import { JobQueue, type HighlightDetectionJob, type RunningJob, type HighlightDetectionParams, type HighlightDetectionProgress } from '@semiont/jobs';
import { resourceId, userId, type EnvironmentConfig, EventBus, type Logger } from '@semiont/core';
import { jobId } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference to avoid external API calls
const mockInferenceClient = vi.hoisted(() => { return { client: null as any }; });
vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockInferenceClient.client = new MockInferenceClient(['[]']);

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
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

describe('HighlightDetectionWorker - Event Emission', () => {
  let worker: HighlightDetectionWorker;
  let testDir: string;
  let testEventStore: EventStore;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-highlight-worker-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration
    config = {
      services: {
        filesystem: {
          platform: { type: 'posix' },
          path: testDir
        },
        backend: {
          platform: { type: 'posix' },
          port: 4000,
          publicURL: 'http://localhost:4000',
          corsOrigin: 'http://localhost:3000'
        },
        inference: {
          platform: { type: 'external' },
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          endpoint: 'https://api.anthropic.com',
          apiKey: 'test-api-key'
        },
        graph: {
          platform: { type: 'posix' },
          type: 'memory'
        }
      },
      site: {
        siteName: 'Test Site',
        domain: 'localhost:3000',
        adminEmail: 'admin@test.local',
        oauthAllowedDomains: ['test.local']
      },
      _metadata: {
        environment: 'test',
        projectRoot: testDir
      },
    } as EnvironmentConfig;

    // Initialize job queue and event store
    const jobQueue = new JobQueue({ dataDir: testDir }, new EventBus());
    await jobQueue.initialize();
    testEventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);
    worker = new HighlightDetectionWorker(jobQueue, config, testEventStore, mockInferenceClient.client, new EventBus(), mockLogger);

    // Set default mock response
    mockInferenceClient.client.setResponses(['[]']);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string, content: string = 'Important content for highlight detection'): Promise<void> {
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);

    const testContent = Buffer.from(content, 'utf-8');
    const { checksum } = await repStore.store(testContent, { mediaType: 'text/plain' });

    await testEventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId(id),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: `Test Resource ${id}`,
        format: 'text/plain',
        contentChecksum: checksum,
        creationMethod: 'api'
      }
    });
  }

  // Helper to get events for a resource
  async function getResourceEvents(resId: string) {
    const allEvents = await testEventStore.log.getEvents(resourceId(resId));
    return allEvents;
  }

  it('should emit job.started event when highlight detection begins', async () => {
    const testResourceId = `resource-highlight-started-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockInferenceClient.client.setResponses([JSON.stringify([])]);

    const job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-highlight-1'),
        type: 'highlight-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    const result = await (worker as unknown as { executeJob: (job: HighlightDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const startedEvents = events.filter(e => e.event.type === 'job.started');
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);

    const startedEvent = startedEvents[0];
    expect(startedEvent).toBeDefined();
    expect(startedEvent!.event).toMatchObject({
      type: 'job.started',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-highlight-1',
        jobType: 'highlight-annotation'
      }
    });
  });

  it('should emit job.progress events during highlight detection', async () => {
    const testResourceId = `resource-highlight-progress-${Date.now()}`;
    await createTestResource(testResourceId, 'Important findings require highlighting');

    // Mock AI response with highlights
    mockInferenceClient.client.setResponses([JSON.stringify([
      {
        exact: 'Important findings',
        start: 0,
        end: 18,
        prefix: '',
        suffix: ' require highlighting'
      }
    ])]);

    const job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-highlight-2'),
        type: 'highlight-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    const result = await (worker as unknown as { executeJob: (job: HighlightDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const progressEvent = progressEvents[0];
    expect(progressEvent!.event).toMatchObject({
      type: 'job.progress',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-highlight-2',
        
      }
    });
  });

  it('should emit job.completed event when highlight detection finishes', async () => {
    const testResourceId = `resource-highlight-complete-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockInferenceClient.client.setResponses([JSON.stringify([
      {
        exact: 'Important',
        start: 0,
        end: 9,
        prefix: '',
        suffix: ' content for'
      }
    ])]);

    const job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-highlight-3'),
        type: 'highlight-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    const result = await (worker as unknown as { executeJob: (job: HighlightDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    const completedEvent = completedEvents[0];
    expect(completedEvent!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-highlight-3',
        
      }
    });
  });

  it('should emit annotation.created events for detected highlights', async () => {
    const testResourceId = `resource-highlight-annotations-${Date.now()}`;
    await createTestResource(testResourceId, 'Key findings and crucial insights need highlighting');

    // Mock AI response with multiple highlights
    mockInferenceClient.client.setResponses([JSON.stringify([
      {
        exact: 'Key findings',
        start: 0,
        end: 12,
        prefix: '',
        suffix: ' and crucial'
      },
      {
        exact: 'crucial insights',
        start: 17,
        end: 33,
        prefix: 'Key findings and ',
        suffix: ' need highlighting'
      }
    ])]);

    const job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-highlight-4'),
        type: 'highlight-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    const result = await (worker as unknown as { executeJob: (job: HighlightDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const annotationEvents = events.filter(e => e.event.type === 'annotation.added');
    expect(annotationEvents.length).toBe(2);

    // Both annotations should be highlighting motivation
    expect(annotationEvents[0]!.event).toMatchObject({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        annotation: {
          motivation: 'highlighting'
        }
      }
    });

    expect(annotationEvents[1]!.event).toMatchObject({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        annotation: {
          motivation: 'highlighting'
        }
      }
    });
  });
});
