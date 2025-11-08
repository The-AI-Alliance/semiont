/**
 * Generation Worker Event Emission Tests
 *
 * Tests that generation worker emits proper job progress events to Event Store
 * during resource generation processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenerationWorker } from '../../jobs/workers/generation-worker';
import type { GenerationJob } from '../../jobs/types';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';
import { resourceId, userId, annotationId } from '@semiont/core';
import { jobId, entityType } from '@semiont/api-client';

// Mock AI generation to avoid external API calls
vi.mock('../../inference/factory', () => ({
  generateResourceFromTopic: vi.fn().mockResolvedValue({
    content: '# Test Resource\n\nGenerated content about test topic.',
    metadata: { format: 'text/markdown' }
  })
}));

// Cache EventStore instances per basePath to ensure consistency
const eventStoreCache = new Map();

// Mock createEventStore to avoid requiring project config
vi.mock('../../services/event-store-service', async (importOriginal) => {
  const actual = await importOriginal() as any;
  const { EventStore } = await import('../../events/event-store');
  const { FilesystemProjectionStorage } = await import('../../storage/projection-storage');

  return {
    ...actual,
    createEventStore: vi.fn(async (envConfig: any) => {
      // Extract basePath from envConfig
      const basePath = envConfig.services.filesystem!.path;

      // Return cached instance if available
      if (eventStoreCache.has(basePath)) {
        return eventStoreCache.get(basePath);
      }

      // Create new instance and cache it
      const projectionStorage = new FilesystemProjectionStorage(basePath);
      const identifierConfig = { baseUrl: 'http://localhost:4000' };
      const eventStore = new EventStore(
        {
          basePath,
          dataDir: basePath,
          enableSharding: false,
          maxEventsPerFile: 100,
        },
        projectionStorage,
        identifierConfig
      );

      eventStoreCache.set(basePath, eventStore);
      return eventStore;
    })
  };
});

// Pre-fetched LLM context (included in job payload, no HTTP call needed)
const mockLLMContext: any = {
  annotation: {
    id: 'test-ref-id',
    motivation: 'linking' as const,
    body: [{
      type: 'TextualBody' as const,
      purpose: 'tagging' as const,
      value: 'Person'
    }],
    target: {
      source: 'source-resource',
      selector: [{
        type: 'TextQuoteSelector' as const,
        exact: 'Test Topic'
      }]
    }
  },
  sourceResource: {
    id: 'source-resource',
    name: 'Source Resource'
  },
  sourceContext: {
    before: 'Context before ',
    selected: 'Test Topic',
    after: ' context after'
  }
};

describe('GenerationWorker - Event Emission', () => {
  let worker: GenerationWorker;
  let testEnv: TestEnvironmentConfig;

  // Helper to create projection for a source resource
  async function createSourceProjection(sourceResourceId: string) {
    const { createProjectionManager } = await import('../../services/storage-service');
    const projectionManager = createProjectionManager(testEnv.config.services.filesystem!.path);

    const projection = {
      resource: {
        '@id': `http://localhost:4000/resources/${sourceResourceId}`,
        id: sourceResourceId,
        name: 'Source Resource'
      },
      annotations: {
        resourceId: sourceResourceId,
        version: 1,
        updatedAt: new Date().toISOString(),
        annotations: [{
          id: 'test-ref-id',
          motivation: 'linking',
          body: [{
            type: 'TextualBody',
            purpose: 'tagging',
            value: 'Person'
          }],
          target: {
            source: sourceResourceId,
            selector: [{
              type: 'TextQuoteSelector',
              exact: 'Test Topic'
            }]
          }
        }]
      }
    };

    await projectionManager.save(resourceId(sourceResourceId), projection as any);
  }

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    worker = new GenerationWorker(testEnv.config);
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('should emit job.started event when generation begins', async () => {
    const job: GenerationJob = {
      id: jobId('job-gen-1'),
      type: 'generation',
      status: 'pending',
      userId: userId('user-1'),
      referenceId: annotationId('test-ref-id'),
      sourceResourceId: resourceId('source-resource-1'),  // Unique per test
      title: 'Test Resource',
      entityTypes: [entityType('Person')],
      llmContext: mockLLMContext,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await createSourceProjection(job.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store using the same path as the worker
    const { createEventStore, createEventQuery } = await import('../../services/event-store-service');
    const eventStore = await createEventStore( testEnv.config);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-1'));

    const startedEvents = events.filter(e => e.event.type === 'job.started');
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);

    expect(startedEvents[0]).toBeDefined();
    expect(startedEvents[0]!.event).toMatchObject({
      type: 'job.started',
      resourceId: resourceId('source-resource-1'),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-gen-1',
        jobType: 'generation',
        totalSteps: 5
      }
    });
  });

  it('should emit job.progress events for each generation stage', async () => {
    const job: GenerationJob = {
      id: jobId('job-gen-2'),
      type: 'generation',
      status: 'pending',
      userId: userId('user-1'),
      referenceId: annotationId('test-ref-id'),
      sourceResourceId: resourceId('source-resource-2'),
      title: 'Test Resource',
      entityTypes: [entityType('Person')],
      llmContext: mockLLMContext,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await createSourceProjection(job.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const { createEventStore, createEventQuery } = await import('../../services/event-store-service');
    const eventStore = await createEventStore( testEnv.config);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-2'));

    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);

    // Check for specific stages (generating, creating)
    // Note: "fetching" stage removed because context is now pre-fetched
    const stages = progressEvents.map(e => (e.event.payload as any).currentStep);
    expect(stages).toContain('generating');
    expect(stages).toContain('creating');
  });

  it('should emit progress events with increasing percentages', async () => {
    const job: GenerationJob = {
      id: jobId('job-gen-3'),
      type: 'generation',
      status: 'pending',
      userId: userId('user-1'),
      referenceId: annotationId('test-ref-id'),
      sourceResourceId: resourceId('source-resource-3'),
      title: 'Test Resource',
      entityTypes: [entityType('Person')],
      llmContext: mockLLMContext,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await createSourceProjection(job.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const { createEventStore, createEventQuery } = await import('../../services/event-store-service');
    const eventStore = await createEventStore( testEnv.config);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-3'));

    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    const percentages = progressEvents.map(e => (e.event.payload as any).percentage);

    // Percentages should be in ascending order
    for (let i = 1; i < percentages.length; i++) {
      expect(percentages[i]).toBeGreaterThan(percentages[i - 1]);
    }

    // Last percentage should be close to 100
    expect(percentages[percentages.length - 1]).toBeGreaterThanOrEqual(85);
  });

  it('should emit job.completed event with resultResourceId', async () => {
    const job: GenerationJob = {
      id: jobId('job-gen-4'),
      type: 'generation',
      status: 'pending',
      userId: userId('user-1'),
      referenceId: annotationId('test-ref-id'),
      sourceResourceId: resourceId('source-resource-4'),
      title: 'Test Resource',
      entityTypes: [entityType('Person')],
      llmContext: mockLLMContext,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await createSourceProjection(job.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const { createEventStore, createEventQuery } = await import('../../services/event-store-service');
    const eventStore = await createEventStore( testEnv.config);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-4'));

    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    expect(completedEvents[0]).toBeDefined();
    expect(completedEvents[0]!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId('source-resource-4'),
      payload: {
        jobId: 'job-gen-4',
        jobType: 'generation',
        resultResourceId: expect.any(String)
      }
    });
  });

  it('should emit resource.created event for new resource', async () => {
    const job: GenerationJob = {
      id: jobId('job-gen-5'),
      type: 'generation',
      status: 'pending',
      userId: userId('user-1'),
      referenceId: annotationId('test-ref-id'),
      sourceResourceId: resourceId('source-resource-5'),
      title: 'Test Resource',
      entityTypes: [entityType('Person')],
      llmContext: mockLLMContext,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await createSourceProjection(job.sourceResourceId);
    await (worker as any).executeJob(job);

    // Get the resultResourceId from job.completed event
    const { createEventStore, createEventQuery } = await import('../../services/event-store-service');
    const eventStore = await createEventStore( testEnv.config);
    const query = createEventQuery(eventStore);
    const sourceEvents = await query.getResourceEvents(resourceId('source-resource-5'));

    const completedEvents = sourceEvents.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThan(0);

    expect(completedEvents[0]).toBeDefined();
    const resultResourceId = (completedEvents[0]!.event.payload as any).resultResourceId;
    expect(resultResourceId).toBeDefined();

    // Now query the new resource's events
    const newResourceEvents = await query.getResourceEvents(resultResourceId);
    const createdEvents = newResourceEvents.filter(e => e.event.type === 'resource.created');

    expect(createdEvents.length).toBeGreaterThan(0);
    expect(createdEvents[0]).toBeDefined();
    expect(createdEvents[0]!.event).toMatchObject({
      type: 'resource.created',
      userId: userId('user-1'),
      payload: {
        name: 'Test Resource',
        format: expect.any(String)
      }
    });
  });

  it('should emit events in correct order', async () => {
    const job: GenerationJob = {
      id: jobId('job-gen-6'),
      type: 'generation',
      status: 'pending',
      userId: userId('user-1'),
      referenceId: annotationId('test-ref-id'),
      sourceResourceId: resourceId('source-resource-6'),
      title: 'Test Resource',
      entityTypes: [entityType('Person')],
      llmContext: mockLLMContext,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await createSourceProjection(job.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const { createEventStore, createEventQuery } = await import('../../services/event-store-service');
    const eventStore = await createEventStore( testEnv.config);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-6'));

    const eventTypes = events.map(e => e.event.type);

    // First event should be job.started
    expect(eventTypes[0]).toBe('job.started');

    // Should contain progress events
    expect(eventTypes.filter(t => t === 'job.progress').length).toBeGreaterThan(0);

    // Last job event should be job.completed
    const lastJobEventIndex = eventTypes.lastIndexOf('job.completed');
    expect(lastJobEventIndex).toBeGreaterThan(0);
  });

  it('should include descriptive messages in progress events', async () => {
    const job: GenerationJob = {
      id: jobId('job-gen-7'),
      type: 'generation',
      status: 'pending',
      userId: userId('user-1'),
      referenceId: annotationId('test-ref-id'),
      sourceResourceId: resourceId('source-resource-7'),
      title: 'Test Resource',
      entityTypes: [entityType('Person')],
      llmContext: mockLLMContext,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await createSourceProjection(job.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const { createEventStore, createEventQuery } = await import('../../services/event-store-service');
    const eventStore = await createEventStore( testEnv.config);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-7'));

    const progressEvents = events.filter(e => e.event.type === 'job.progress');

    for (const event of progressEvents) {
      expect(event.event.payload).toHaveProperty('message');
      expect(typeof (event.event.payload as any).message).toBe('string');
      expect((event.event.payload as any).message.length).toBeGreaterThan(0);
    }
  });
});
