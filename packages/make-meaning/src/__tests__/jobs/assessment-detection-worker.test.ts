/**
 * Assessment Detection Worker Event Emission Tests
 *
 * Tests that AssessmentDetectionWorker emits proper job progress events to Event Store
 * during assessment detection processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AssessmentDetectionWorker } from '../../jobs/assessment-detection-worker';
import { JobQueue, type AssessmentDetectionJob, type RunningJob, type AssessmentDetectionParams, type AssessmentDetectionProgress } from '@semiont/jobs';
import { resourceId, userId, type EnvironmentConfig, EventBus } from '@semiont/core';
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

describe('AssessmentDetectionWorker - Event Emission', () => {
  let worker: AssessmentDetectionWorker;
  let testDir: string;
  let testEventStore: EventStore;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-assessment-worker-${Date.now()}`);
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
    testEventStore = createEventStore(testDir, config.services.backend!.publicURL);
    worker = new AssessmentDetectionWorker(jobQueue, config, testEventStore, mockInferenceClient.client, new EventBus());

    // Set default mock response
    mockInferenceClient.client.setResponses(['[]']);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string, content: string = 'Claims requiring assessment'): Promise<void> {
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

  it('should emit job.started event when assessment detection begins', async () => {
    const testResourceId = `resource-assessment-started-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockInferenceClient.client.setResponses([JSON.stringify([])]);

    const job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-assessment-1'),
        type: 'assessment-annotation',
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

    const result = await (worker as unknown as { executeJob: (job: AssessmentDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

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
        jobId: 'job-assessment-1',
        jobType: 'assessment-annotation'
      }
    });
  });

  it('should emit job.progress events during assessment detection', async () => {
    const testResourceId = `resource-assessment-progress-${Date.now()}`;
    await createTestResource(testResourceId, 'This claim requires critical evaluation');

    // Mock AI response with assessments
    mockInferenceClient.client.setResponses([JSON.stringify([
          {
            exact: 'This claim',
            start: 0,
            end: 10,
            assessment: 'This claim lacks supporting evidence',
            prefix: '',
            suffix: ' requires critical'
          }
        ])]);

    const job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-assessment-2'),
        type: 'assessment-annotation',
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

    const result = await (worker as unknown as { executeJob: (job: AssessmentDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const progressEvent = progressEvents[0];
    expect(progressEvent!.event).toMatchObject({
      type: 'job.progress',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-assessment-2',
        
      }
    });
  });

  it('should emit job.completed event when assessment detection finishes', async () => {
    const testResourceId = `resource-assessment-complete-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockInferenceClient.client.setResponses([JSON.stringify([
          {
            exact: 'Claims',
            start: 0,
            end: 6,
            assessment: 'Needs verification',
            prefix: '',
            suffix: ' requiring assessment'
          }
        ])]);

    const job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-assessment-3'),
        type: 'assessment-annotation',
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

    const result = await (worker as unknown as { executeJob: (job: AssessmentDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    const completedEvent = completedEvents[0];
    expect(completedEvent!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-assessment-3',
        
      }
    });
  });

  it('should emit annotation.created events for detected assessments', async () => {
    const testResourceId = `resource-assessment-annotations-${Date.now()}`;
    await createTestResource(testResourceId, 'First claim needs review. Second claim also questionable.');

    // Mock AI response with multiple assessments
    mockInferenceClient.client.setResponses([JSON.stringify([
          {
            exact: 'First claim',
            start: 0,
            end: 11,
            assessment: 'This claim lacks empirical support',
            prefix: '',
            suffix: ' needs review'
          },
          {
            exact: 'Second claim',
            start: 26,
            end: 38,
            assessment: 'Requires additional verification',
            prefix: 'needs review. ',
            suffix: ' also questionable'
          }
        ])]);

    const job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-assessment-4'),
        type: 'assessment-annotation',
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

    const result = await (worker as unknown as { executeJob: (job: AssessmentDetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const annotationEvents = events.filter(e => e.event.type === 'annotation.added');
    expect(annotationEvents.length).toBe(2);

    // Check first assessment annotation
    expect(annotationEvents[0]!.event).toMatchObject({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        annotation: {
          motivation: 'assessing',
          body: expect.objectContaining({
            value: 'This claim lacks empirical support'
          })
        }
      }
    });

    // Check second assessment annotation
    expect(annotationEvents[1]!.event).toMatchObject({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        annotation: {
          motivation: 'assessing',
          body: expect.objectContaining({
            value: 'Requires additional verification'
          })
        }
      }
    });
  });
});
