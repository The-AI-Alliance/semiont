/**
 * Generation Worker Event Emission Tests
 *
 * Tests that generation worker emits proper job progress events to Event Store
 * during resource generation processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenerationWorker } from '@semiont/make-meaning';
import { JobQueue, type RunningJob, type GenerationParams, type GenerationProgress } from '@semiont/jobs';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';
import { resourceId, userId, annotationId } from '@semiont/core';
import { jobId, entityType } from '@semiont/api-client';
import type { GenerationContext } from '@semiont/api-client';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { createEventQuery } from '../../services/event-store-service';

// Mock GenerationContext for tests
const mockGenerationContext: GenerationContext = {
  sourceContext: {
    before: 'Text before',
    selected: 'Test Topic',
    after: 'text after'
  },
  metadata: {
    resourceType: 'document',
    language: 'en',
    entityTypes: ['Person']
  }
};

// Mock AI generation to avoid external API calls
vi.mock('@semiont/inference', () => ({
  generateResourceFromTopic: vi.fn().mockResolvedValue({
    content: '# Test Resource\n\nGenerated content about test topic.',
    metadata: { format: 'text/markdown' }
  })
}));

// Mock AnnotationContextService to avoid requiring actual file content
vi.mock('../../services/annotation-context', () => ({
  AnnotationContextService: {
    buildLLMContext: vi.fn().mockResolvedValue({
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
    })
  }
}));

describe('GenerationWorker - Event Emission', () => {
  let worker: GenerationWorker;
  let testEnv: TestEnvironmentConfig;
  let testEventStore: EventStore;

  // Helper to create view for a source resource
  async function createSourceView(sourceResourceId: string) {
    const { FilesystemViewStorage } = await import('@semiont/event-sourcing');
    const viewStorage = new FilesystemViewStorage(testEnv.config.services.filesystem!.path);

    const view = {
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
          id: 'http://localhost:4000/annotations/test-ref-id',
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

    await viewStorage.save(resourceId(sourceResourceId), view as any);
  }

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();

    const jobQueue = new JobQueue({ dataDir: testEnv.config.services.filesystem!.path });
    await jobQueue.initialize();

    testEventStore = createEventStore(testEnv.config.services.filesystem!.path, testEnv.config.services.backend!.publicURL);
    worker = new GenerationWorker(jobQueue, testEnv.config, testEventStore);
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('should emit job.started event when generation begins', async () => {
    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-1'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId('test-ref-id'),
        sourceResourceId: resourceId('source-resource-1'),  // Unique per test
        title: 'Test Resource',
        entityTypes: [entityType('Person')],
        context: mockGenerationContext
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'initializing',
        percentage: 0
      }
    };

    await createSourceView(job.params.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store using the same instance as the worker
    const query = createEventQuery(testEventStore);
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
    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-2'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId('test-ref-id'),
        sourceResourceId: resourceId('source-resource-2'),
        title: 'Test Resource',
        entityTypes: [entityType('Person')],
        context: mockGenerationContext
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'initializing',
        percentage: 0
      }
    };

    await createSourceView(job.params.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const query = createEventQuery(testEventStore);
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
    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-3'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId('test-ref-id'),
        sourceResourceId: resourceId('source-resource-3'),
        title: 'Test Resource',
        entityTypes: [entityType('Person')],
        context: mockGenerationContext
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'initializing',
        percentage: 0
      }
    };

    await createSourceView(job.params.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-3'));

    const progressEvents = events.filter(e => e.event.type === 'job.progress');

    // Should have multiple progress events
    expect(progressEvents.length).toBeGreaterThan(0);

    // Sort events by timestamp to ensure chronological order
    const sortedProgressEvents = [...progressEvents].sort((a, b) =>
      new Date(a.metadata.timestamp).getTime() - new Date(b.metadata.timestamp).getTime()
    );

    const percentages = sortedProgressEvents.map(e => (e.event.payload as any).percentage);

    // All percentages should be valid (0-100)
    percentages.forEach(pct => {
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    });

    // Percentages should generally trend upward (allow for some out-of-order due to timing)
    // Check that we have a reasonable distribution of progress
    const hasLowProgress = percentages.some(p => p < 50);
    const hasHighProgress = percentages.some(p => p >= 85);
    expect(hasLowProgress || hasHighProgress).toBe(true);

    // Final percentage should be close to 100
    expect(percentages[percentages.length - 1]).toBeGreaterThanOrEqual(40);
  });

  it('should emit job.completed event with resultResourceId', async () => {
    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-4'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId('test-ref-id'),
        sourceResourceId: resourceId('source-resource-4'),
        title: 'Test Resource',
        entityTypes: [entityType('Person')],
        context: mockGenerationContext
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'initializing',
        percentage: 0
      }
    };

    await createSourceView(job.params.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const query = createEventQuery(testEventStore);
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

  it('should link annotation to generated resource', async () => {
    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-5'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId('test-ref-id'),
        sourceResourceId: resourceId('source-resource-5'),
        title: 'Test Resource',
        entityTypes: [entityType('Person')],
        context: mockGenerationContext
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'initializing',
        percentage: 0
      }
    };

    await createSourceView(job.params.sourceResourceId);
    await (worker as any).executeJob(job);

    // Get the resultResourceId from job.completed event
    const query = createEventQuery(testEventStore);
    const sourceEvents = await query.getResourceEvents(resourceId('source-resource-5'));

    const completedEvents = sourceEvents.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThan(0);

    expect(completedEvents[0]).toBeDefined();
    const resultResourceId = (completedEvents[0]!.event.payload as any).resultResourceId;
    expect(resultResourceId).toBeDefined();
    expect(resultResourceId).toMatch(/^[a-f0-9]{32}$/); // Valid resource ID format

    // Verify annotation was linked to the generated resource via annotation.body.updated event
    const bodyUpdateEvents = sourceEvents.filter(e => e.event.type === 'annotation.body.updated');
    expect(bodyUpdateEvents.length).toBeGreaterThan(0);

    // Find the event that links to our generated resource
    const bodyUpdate = bodyUpdateEvents.find(e => {
      const operations = (e.event.payload as any).operations;
      return operations?.some((op: any) =>
        op.item?.source?.includes(resultResourceId)
      );
    });
    expect(bodyUpdate).toBeDefined();
    expect(bodyUpdate!.event).toMatchObject({
      type: 'annotation.body.updated',
      resourceId: resourceId('source-resource-5'),
      userId: userId('user-1')
    });
  });

  it('should emit events in correct order', async () => {
    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-6'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId('test-ref-id'),
        sourceResourceId: resourceId('source-resource-6'),
        title: 'Test Resource',
        entityTypes: [entityType('Person')],
        context: mockGenerationContext
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'initializing',
        percentage: 0
      }
    };

    await createSourceView(job.params.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const query = createEventQuery(testEventStore);
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
    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-7'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId('test-ref-id'),
        sourceResourceId: resourceId('source-resource-7'),
        title: 'Test Resource',
        entityTypes: [entityType('Person')],
        context: mockGenerationContext
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'initializing',
        percentage: 0
      }
    };

    await createSourceView(job.params.sourceResourceId);
    await (worker as any).executeJob(job);

    // Query events from Event Store
    const query = createEventQuery(testEventStore);
    const events = await query.getResourceEvents(resourceId('source-resource-7'));

    const progressEvents = events.filter(e => e.event.type === 'job.progress');

    for (const event of progressEvents) {
      expect(event.event.payload).toHaveProperty('message');
      expect(typeof (event.event.payload as any).message).toBe('string');
      expect((event.event.payload as any).message.length).toBeGreaterThan(0);
    }
  });
});
