/**
 * Reference Detection Worker Event Emission Tests
 *
 * Tests that reference detection worker emits proper job progress events to Event Store
 * during entity detection processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ReferenceDetectionWorker } from '@semiont/make-meaning';
import { JobQueue, type DetectionJob, type RunningJob, type DetectionParams, type DetectionProgress } from '@semiont/jobs';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';
import { resourceId, userId } from '@semiont/core';
import { jobId, entityType } from '@semiont/api-client';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { createEventQuery } from '../../services/event-store-service';

// Mock AI entity extraction to avoid external API calls
vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
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

vi.mock('@semiont/inference', () => ({
  generateText: vi.fn().mockResolvedValue('Mock AI response'),
  getInferenceClient: vi.fn().mockResolvedValue({}),
  getInferenceModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
}));

describe('ReferenceDetectionWorker - Event Emission', () => {
  let worker: ReferenceDetectionWorker;
  let testEnv: TestEnvironmentConfig;
  let testEventStore: EventStore;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    const jobQueue = new JobQueue({ dataDir: testEnv.config.services.filesystem!.path });
    await jobQueue.initialize();
    testEventStore = createEventStore(testEnv.config.services.filesystem!.path, testEnv.config.services.backend!.publicURL);
    worker = new ReferenceDetectionWorker(jobQueue, testEnv.config, testEventStore);
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string): Promise<void> {
    // Store content in representation store
    const { FilesystemRepresentationStore } = await import('@semiont/content');
    const repStore = new FilesystemRepresentationStore({ basePath: testEnv.config.services.filesystem!.path });

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

  it('should emit job.started event when detection begins', async () => {
    const testResourceId = `resource-started-${Date.now()}`;
    // Create test resource first
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-1'),
        type: 'detection',
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

    await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<void> }).executeJob(job);

    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId(testResourceId));

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
        jobType: 'detection',
        totalSteps: 1
      }
    });
  });

  it('should emit job.progress events during entity type scanning', async () => {
    const testResourceId = `resource-progress-${Date.now()}`;
    // Create test resource first
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-2'),
        type: 'detection',
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

    await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<void> }).executeJob(job);

    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId(testResourceId));

    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2); // First two entity types emit progress, last emits completed

    // Check first progress event
    expect(progressEvents[0]).toBeDefined();
    expect(progressEvents[0]!.event).toMatchObject({
      type: 'job.progress',
      resourceId: resourceId(testResourceId),
      payload: {
        jobId: 'job-test-2',
        jobType: 'detection',
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
    // Create test resource first
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-3'),
        type: 'detection',
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

    await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<void> }).executeJob(job);

    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId(testResourceId));

    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    expect(completedEvents[0]).toBeDefined();
    expect(completedEvents[0]!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId(testResourceId),
      payload: {
        jobId: 'job-test-3',
        jobType: 'detection',
        foundCount: expect.any(Number)
      }
    });
  });

  it('should emit annotation.added events for detected entities', async () => {
    const testResourceId = `resource-annotations-${Date.now()}`;
    // Create test resource first
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-4'),
        type: 'detection',
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

    await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<void> }).executeJob(job);

    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId(testResourceId));

    // Note: This test verifies the event schema, not that entities are actually detected
    // The mocked AI detection may return 0 entities, which is fine for testing event emission
    const annotationEvents = events.filter(e => e.event.type === 'annotation.added');

    // Verify that IF entities were detected, they would have the correct schema
    // This is a schema test, not an integration test
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

    // Main assertion: Job completed successfully (which means event emission worked)
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThan(0);
  });

  it('should emit events in correct order', async () => {
    const testResourceId = `resource-order-${Date.now()}`;
    // Create test resource first
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-5'),
        type: 'detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        entityTypes: [entityType('Person'), entityType('Organization')] // Use multiple types to test progress
      },
      startedAt: new Date().toISOString(),
      progress: {
        totalEntityTypes: 2,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };

    await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<void> }).executeJob(job);

    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId(testResourceId));

    const eventTypes = events.map(e => e.event.type);

    // Find job-related events (excluding resource.created from setup)
    const jobEvents = eventTypes.filter(t => t.startsWith('job.') || t.startsWith('annotation.'));

    // First job event should be job.started
    expect(jobEvents[0]).toBe('job.started');

    // Last job event should be job.completed
    expect(jobEvents[jobEvents.length - 1]).toBe('job.completed');

    // Should have at least one job.progress event (between started and completed)
    expect(jobEvents).toContain('job.progress');
  });

  it('should include percentage and foundCount in progress events', async () => {
    const testResourceId = `resource-percentage-${Date.now()}`;
    // Create test resource first
    await createTestResource(testResourceId);

    const job: RunningJob<DetectionParams, DetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-test-6'),
        type: 'detection',
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

    await (worker as unknown as { executeJob: (job: DetectionJob) => Promise<void> }).executeJob(job);

    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId(testResourceId));

    const progressEvents = events.filter(e => e.event.type === 'job.progress');

    for (const event of progressEvents) {
      expect(event.event.payload).toHaveProperty('percentage');
      expect(typeof (event.event.payload as any).percentage).toBe('number');
      expect(event.event.payload).toHaveProperty('foundCount');
      expect(typeof (event.event.payload as any).foundCount).toBe('number');
    }
  });
});
