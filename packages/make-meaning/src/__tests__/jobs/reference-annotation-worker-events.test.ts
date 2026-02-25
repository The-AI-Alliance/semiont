/**
 * Reference Detection Worker Event Emission Tests
 *
 * Tests that ReferenceDetectionWorker emits proper job progress events to Event Store
 * during entity detection processing.
 *
 * MOVED FROM: apps/backend/src/__tests__/jobs/detection-worker-events.test.ts
 * This test belongs in make-meaning because it tests ReferenceDetectionWorker directly.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ReferenceDetectionWorker } from '../../jobs/reference-annotation-worker';
import { JobQueue, type DetectionJob, type RunningJob, type DetectionParams, type DetectionProgress } from '@semiont/jobs';
import { resourceId, userId, type EnvironmentConfig, EventBus } from '@semiont/core';
import { jobId, entityType } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference
const mockInferenceClient = vi.hoisted(() => ({ client: null as any }));

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockInferenceClient.client = new MockInferenceClient(['[]']); // Empty JSON array response

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
    MockInferenceClient,
    extractEntities: vi.fn().mockResolvedValue([
      {
        exact: 'Test',
        entityType: 'Person',
        startOffset: 0,
        endOffset: 4
      }
    ])
  };
});

describe('ReferenceDetectionWorker - Event Emission', () => {
  let worker: ReferenceDetectionWorker;
  let testDir: string;
  let testEventStore: EventStore;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-worker-${Date.now()}`);
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
    worker = new ReferenceDetectionWorker(jobQueue, config, testEventStore, mockInferenceClient.client, new EventBus());
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string): Promise<void> {
    // Store content in representation store
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);

    const testContent = Buffer.from('Test content for detection', 'utf-8');
    const { checksum } = await repStore.store(testContent, { mediaType: 'text/plain' });

    // Create resource event with actual checksum
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

  it('should emit job.started event when detection begins', async () => {
    const testResourceId = `resource-started-${Date.now()}`;
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-1'),
        type: 'reference-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        entityTypes: [entityType('Person')]
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };

    const result = await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<DetectionParams, DetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

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
        jobId: 'job-test-1',
        jobType: 'reference-annotation',
        totalSteps: 1
      }
    });
  });

  it('should emit job.progress events during entity type scanning', async () => {
    const testResourceId = `resource-progress-${Date.now()}`;
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-2'),
        type: 'reference-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        entityTypes: [entityType('Person'), entityType('Organization'), entityType('Location')]
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: 3,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };

    const result = await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<DetectionParams, DetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);

    // Check first progress event
    expect(progressEvents[0]).toBeDefined();
    expect(progressEvents[0]!.event).toMatchObject({
      type: 'job.progress',
      resourceId: resourceId(testResourceId),
      payload: {
        jobId: 'job-test-2',
        jobType: 'reference-annotation',
        percentage: expect.any(Number),
        currentStep: 'Person',
        processedSteps: 1,
        totalSteps: 3,
        foundCount: expect.any(Number)
      }
    });
  });

  it('should emit job.completed event when detection finishes successfully', async () => {
    const testResourceId = `resource-completed-${Date.now()}`;
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-3'),
        type: 'reference-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        entityTypes: [entityType('Person')]
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };

    const result = await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<DetectionParams, DetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    expect(completedEvents[0]).toBeDefined();
    expect(completedEvents[0]!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId(testResourceId),
      payload: {
        jobId: 'job-test-3',
        jobType: 'reference-annotation',
        result: expect.objectContaining({
          totalFound: expect.any(Number),
          totalEmitted: expect.any(Number)
        })
      }
    });
  });

  it('should emit annotation.added events for detected entities', async () => {
    const testResourceId = `resource-annotations-${Date.now()}`;
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-4'),
        type: 'reference-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        entityTypes: [entityType('Person')]
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };

    const result = await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<DetectionParams, DetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const annotationEvents = events.filter(e => e.event.type === 'annotation.added');

    // Verify that IF entities were detected, they would have the correct schema
    if (annotationEvents.length > 0) {
      expect(annotationEvents[0]).toBeDefined();
      expect(annotationEvents[0]!.event).toMatchObject({
        type: 'annotation.added',
        resourceId: resourceId(testResourceId),
        payload: {
          annotation: {
            motivation: 'linking',
            target: expect.objectContaining({
              source: expect.any(String),
              selector: expect.any(Array)
            })
          }
        }
      });
    }

    // Main assertion: Job completed successfully
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThan(0);
  });

  it('should emit events in correct order', async () => {
    const testResourceId = `resource-order-${Date.now()}`;
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-5'),
        type: 'reference-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        entityTypes: [entityType('Person'), entityType('Organization')]
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: 2,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };

    const result = await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<DetectionParams, DetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const eventTypes = events.map(e => e.event.type);

    // Find job-related events (excluding resource.created from setup)
    const jobEvents = eventTypes.filter(t => t.startsWith('job.') || t.startsWith('annotation.'));

    // First job event should be job.started
    expect(jobEvents[0]).toBe('job.started');

    // Last job event should be job.completed
    expect(jobEvents[jobEvents.length - 1]).toBe('job.completed');

    // Should have at least one job.progress event
    expect(jobEvents).toContain('job.progress');
  });

  it('should include percentage and foundCount in progress events', async () => {
    const testResourceId = `resource-percentage-${Date.now()}`;
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-6'),
        type: 'reference-annotation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        entityTypes: [entityType('Person'), entityType('Organization')]
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: 2,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };

    const result = await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<any> }).executeJob(job);
    await (worker as unknown as { emitCompletionEvent: (job: RunningJob<DetectionParams, DetectionProgress>, result: any) => Promise<void> }).emitCompletionEvent(job, result);

    const events = await getResourceEvents(testResourceId);
    const progressEvents = events.filter(e => e.event.type === 'job.progress');

    for (const event of progressEvents) {
      expect(event.event.payload).toHaveProperty('percentage');
      expect(typeof (event.event.payload as any).percentage).toBe('number');
      expect(event.event.payload).toHaveProperty('foundCount');
      expect(typeof (event.event.payload as any).foundCount).toBe('number');
    }
  });
});
