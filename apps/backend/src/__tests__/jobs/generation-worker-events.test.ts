/**
 * Generation Worker Event Emission Tests
 *
 * Tests that generation worker emits proper job progress events to Event Store
 * during resource generation processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenerationWorker } from '../../jobs/workers/generation-worker';
import { EventStore } from '../../events/event-store';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import type { GenerationJob } from '../../jobs/types';
import type { StoredEvent } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock AI generation to avoid external API calls
vi.mock('../../inference/generate-resource', () => ({
  generateResourceFromTopic: vi.fn().mockResolvedValue({
    content: '# Test Resource\n\nGenerated content about test topic.',
    metadata: { format: 'text/markdown' }
  })
}));

// Mock annotation queries
vi.mock('../../services/annotation-queries', () => ({
  AnnotationQueryService: {
    getResourceAnnotations: vi.fn().mockResolvedValue({
      resourceId: 'source-resource',
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
          source: 'source-resource',
          selector: [{
            type: 'TextQuoteSelector',
            exact: 'Test Topic'
          }]
        }
      }]
    })
  }
}));

// Mock resource queries
vi.mock('../../services/resource-queries', () => ({
  ResourceQueryService: {
    getResourceMetadata: vi.fn().mockResolvedValue({
      id: 'source-resource',
      name: 'Source Resource',
      format: 'text/plain'
    })
  }
}));

// Mock environment
vi.mock('../../config/environment-loader', () => ({
  getFilesystemConfig: () => ({ path: testDir })
}));

let testDir: string;

describe('GenerationWorker - Event Emission', () => {
  let eventStore: EventStore;
  let worker: GenerationWorker;
  let emittedEvents: StoredEvent[] = [];

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-generation-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    process.env.BACKEND_URL = 'http://localhost:4000';

    const projectionStorage = new FilesystemProjectionStorage(testDir);
    eventStore = new EventStore({
      basePath: testDir,
      dataDir: testDir,
      enableSharding: false,
      maxEventsPerFile: 100,
    }, projectionStorage);

    worker = new GenerationWorker();

    // Capture all events emitted during processing
    const originalAppendEvent = eventStore.appendEvent.bind(eventStore);
    vi.spyOn(eventStore, 'appendEvent').mockImplementation(async (event) => {
      const stored = await originalAppendEvent(event);
      emittedEvents.push(stored);
      return stored;
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should emit job.started event when generation begins', async () => {
    emittedEvents = [];

    const job: GenerationJob = {
      id: 'job-gen-1',
      type: 'generation',
      status: 'pending',
      userId: 'user-1',
      referenceId: 'test-ref-id',
      sourceResourceId: 'source-resource',
      title: 'Test Resource',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const startedEvents = emittedEvents.filter(e => e.event.type === 'job.started');
    expect(startedEvents).toHaveLength(1);

    expect(startedEvents[0].event).toMatchObject({
      type: 'job.started',
      resourceId: 'source-resource',
      userId: 'user-1',
      payload: {
        jobId: 'job-gen-1',
        jobType: 'generation',
        totalSteps: 5
      }
    });
  });

  it('should emit job.progress events for each generation stage', async () => {
    emittedEvents = [];

    const job: GenerationJob = {
      id: 'job-gen-2',
      type: 'generation',
      status: 'pending',
      userId: 'user-1',
      referenceId: 'test-ref-id',
      sourceResourceId: 'source-resource',
      title: 'Test Resource',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const progressEvents = emittedEvents.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(4);

    // Check for specific stages
    const stages = progressEvents.map(e => e.event.payload.currentStep);
    expect(stages).toContain('fetching');
    expect(stages).toContain('generating');
    expect(stages).toContain('creating');
    expect(stages).toContain('linking');
  });

  it('should emit progress events with increasing percentages', async () => {
    emittedEvents = [];

    const job: GenerationJob = {
      id: 'job-gen-3',
      type: 'generation',
      status: 'pending',
      userId: 'user-1',
      referenceId: 'test-ref-id',
      sourceResourceId: 'source-resource',
      title: 'Test Resource',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const progressEvents = emittedEvents.filter(e => e.event.type === 'job.progress');
    const percentages = progressEvents.map(e => e.event.payload.percentage);

    // Percentages should be in ascending order
    for (let i = 1; i < percentages.length; i++) {
      expect(percentages[i]).toBeGreaterThan(percentages[i - 1]);
    }

    // Last percentage should be close to 100
    expect(percentages[percentages.length - 1]).toBeGreaterThanOrEqual(85);
  });

  it('should emit job.completed event with resultResourceId', async () => {
    emittedEvents = [];

    const job: GenerationJob = {
      id: 'job-gen-4',
      type: 'generation',
      status: 'pending',
      userId: 'user-1',
      referenceId: 'test-ref-id',
      sourceResourceId: 'source-resource',
      title: 'Test Resource',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const completedEvents = emittedEvents.filter(e => e.event.type === 'job.completed');
    expect(completedEvents).toHaveLength(1);

    expect(completedEvents[0].event).toMatchObject({
      type: 'job.completed',
      resourceId: 'source-resource',
      payload: {
        jobId: 'job-gen-4',
        jobType: 'generation',
        resultResourceId: expect.any(String)
      }
    });
  });

  it('should emit resource.created event for new resource', async () => {
    emittedEvents = [];

    const job: GenerationJob = {
      id: 'job-gen-5',
      type: 'generation',
      status: 'pending',
      userId: 'user-1',
      referenceId: 'test-ref-id',
      sourceResourceId: 'source-resource',
      title: 'Test Resource',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const createdEvents = emittedEvents.filter(e => e.event.type === 'resource.created');
    expect(createdEvents.length).toBeGreaterThan(0);

    expect(createdEvents[0].event).toMatchObject({
      type: 'resource.created',
      userId: 'user-1',
      payload: {
        name: 'Test Resource',
        format: expect.any(String)
      }
    });
  });

  it('should emit events in correct order', async () => {
    emittedEvents = [];

    const job: GenerationJob = {
      id: 'job-gen-6',
      type: 'generation',
      status: 'pending',
      userId: 'user-1',
      referenceId: 'test-ref-id',
      sourceResourceId: 'source-resource',
      title: 'Test Resource',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const eventTypes = emittedEvents.map(e => e.event.type);

    // First event should be job.started
    expect(eventTypes[0]).toBe('job.started');

    // Should contain progress events
    expect(eventTypes.filter(t => t === 'job.progress').length).toBeGreaterThan(0);

    // Should contain resource.created
    expect(eventTypes).toContain('resource.created');

    // Last job event should be job.completed
    const lastJobEventIndex = eventTypes.lastIndexOf('job.completed');
    expect(lastJobEventIndex).toBeGreaterThan(0);
  });

  it('should include descriptive messages in progress events', async () => {
    emittedEvents = [];

    const job: GenerationJob = {
      id: 'job-gen-7',
      type: 'generation',
      status: 'pending',
      userId: 'user-1',
      referenceId: 'test-ref-id',
      sourceResourceId: 'source-resource',
      title: 'Test Resource',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const progressEvents = emittedEvents.filter(e => e.event.type === 'job.progress');

    for (const event of progressEvents) {
      expect(event.event.payload).toHaveProperty('message');
      expect(typeof event.event.payload.message).toBe('string');
      expect(event.event.payload.message.length).toBeGreaterThan(0);
    }
  });
});
