/**
 * Detection Worker Event Emission Tests
 *
 * Tests that detection worker emits proper job progress events to Event Store
 * during entity detection processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DetectionWorker } from '../../jobs/workers/detection-worker';
import { EventStore } from '../../events/event-store';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import type { DetectionJob } from '../../jobs/types';
import type { StoredEvent } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock AI detection to avoid external API calls
vi.mock('../../inference/detect-annotations', () => ({
  detectAnnotationsInResource: vi.fn().mockResolvedValue([
    {
      annotation: {
        selector: { start: 0, end: 4 },
        exact: 'Test'
      },
      entityType: 'Person',
      confidence: 0.9
    }
  ])
}));

// Mock resource queries
vi.mock('../../services/resource-queries', () => ({
  ResourceQueryService: {
    getResourceMetadata: vi.fn().mockResolvedValue({
      id: 'test-resource',
      name: 'Test Resource',
      format: 'text/plain'
    })
  }
}));

// Mock environment
vi.mock('../../config/environment-loader', () => ({
  getFilesystemConfig: () => ({ path: testDir })
}));

let testDir: string;

describe('DetectionWorker - Event Emission', () => {
  let eventStore: EventStore;
  let worker: DetectionWorker;
  let emittedEvents: StoredEvent[] = [];

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-detection-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    process.env.BACKEND_URL = 'http://localhost:4000';

    const projectionStorage = new FilesystemProjectionStorage(testDir);
    eventStore = new EventStore({
      basePath: testDir,
      dataDir: testDir,
      enableSharding: false,
      maxEventsPerFile: 100,
    }, projectionStorage);

    worker = new DetectionWorker();

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

  it('should emit job.started event when detection begins', async () => {
    emittedEvents = [];

    const job: DetectionJob = {
      id: 'job-test-1',
      type: 'detection',
      status: 'pending',
      userId: 'user-1',
      resourceId: 'resource-1',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const startedEvents = emittedEvents.filter(e => e.event.type === 'job.started');
    expect(startedEvents).toHaveLength(1);

    const startedEvent = startedEvents[0];
    expect(startedEvent.event).toMatchObject({
      type: 'job.started',
      resourceId: 'resource-1',
      userId: 'user-1',
      payload: {
        jobId: 'job-test-1',
        jobType: 'detection',
        totalSteps: 1
      }
    });
  });

  it('should emit job.progress events during entity type scanning', async () => {
    emittedEvents = [];

    const job: DetectionJob = {
      id: 'job-test-2',
      type: 'detection',
      status: 'pending',
      userId: 'user-1',
      resourceId: 'resource-2',
      entityTypes: ['Person', 'Organization', 'Location'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const progressEvents = emittedEvents.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(3); // At least one per entity type

    // Check first progress event
    expect(progressEvents[0].event).toMatchObject({
      type: 'job.progress',
      resourceId: 'resource-2',
      payload: {
        jobId: 'job-test-2',
        jobType: 'detection',
        currentStep: 'Person',
        processedSteps: 0,
        totalSteps: 3
      }
    });

    // Check progress percentage increases
    const percentages = progressEvents.map(e => e.event.payload.percentage);
    expect(percentages[0]).toBeLessThan(percentages[percentages.length - 1]);
  });

  it('should emit job.completed event when detection finishes successfully', async () => {
    emittedEvents = [];

    const job: DetectionJob = {
      id: 'job-test-3',
      type: 'detection',
      status: 'pending',
      userId: 'user-1',
      resourceId: 'resource-3',
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
      resourceId: 'resource-3',
      payload: {
        jobId: 'job-test-3',
        jobType: 'detection'
      }
    });
  });

  it('should emit annotation.added events for detected entities', async () => {
    emittedEvents = [];

    const job: DetectionJob = {
      id: 'job-test-4',
      type: 'detection',
      status: 'pending',
      userId: 'user-1',
      resourceId: 'resource-4',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const annotationEvents = emittedEvents.filter(e => e.event.type === 'annotation.added');
    expect(annotationEvents.length).toBeGreaterThan(0);

    expect(annotationEvents[0].event).toMatchObject({
      type: 'annotation.added',
      resourceId: 'resource-4',
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
  });

  it('should emit events in correct order', async () => {
    emittedEvents = [];

    const job: DetectionJob = {
      id: 'job-test-5',
      type: 'detection',
      status: 'pending',
      userId: 'user-1',
      resourceId: 'resource-5',
      entityTypes: ['Person'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const eventTypes = emittedEvents.map(e => e.event.type);

    // First event should be job.started
    expect(eventTypes[0]).toBe('job.started');

    // Last event should be job.completed
    expect(eventTypes[eventTypes.length - 1]).toBe('job.completed');

    // Should have at least one job.progress event
    expect(eventTypes).toContain('job.progress');
  });

  it('should include foundCount in progress events', async () => {
    emittedEvents = [];

    const job: DetectionJob = {
      id: 'job-test-6',
      type: 'detection',
      status: 'pending',
      userId: 'user-1',
      resourceId: 'resource-6',
      entityTypes: ['Person', 'Organization'],
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await worker.process(job);

    const progressEvents = emittedEvents.filter(e => e.event.type === 'job.progress');

    for (const event of progressEvents) {
      expect(event.event.payload).toHaveProperty('foundCount');
      expect(typeof event.event.payload.foundCount).toBe('number');
    }
  });
});
